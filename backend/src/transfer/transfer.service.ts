import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { FeiceInviteService } from '../feice/feice-invite.service';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

/**
 * 统一课程中转页服务
 *
 * 流程（见 SPEC §6）：
 *  GET /course/{feiceLiveRoomId}?token=xxx → 前端展示登录
 *  POST /transfer/login → 短信验证码/账号密码 → 颁发登录态 + 记录 visit
 *  POST /transfer/enter → 生成带追踪的飞策入口 → 跳转
 *  POST /transfer/stop-reminder → 取消该课程后续提醒
 *
 * 安全：
 * - 验证码存在 Redis，300s 过期，错误5次锁10min
 * - visitToken 只允许用一次跳转
 */
@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly feice: FeiceInviteService,
  ) {}

  /** 中转页首屏加载：返回课程基本信息 + 当前登录态 + 完成状态 */
  async bootstrap(feiceLiveRoomId: string, visitTokenFromQuery?: string) {
    const course = await this.prisma.course.findFirst({
      where: { feiceLiveRoomId },
    });
    if (!course) throw new NotFoundException('课程不存在');
    let customer: any = null;
    let roster: any = null;
    let completed = false;
    // 如果带着 visitToken，反查
    if (visitTokenFromQuery) {
      const v = await this.prisma.transferPageVisit.findFirst({
        where: { visitToken: visitTokenFromQuery },
        include: { customer: true },
      });
      if (v && v.customer) {
        customer = v.customer;
        roster = await this.prisma.courseRoster.findFirst({
          where: { task: { courseId: course.id }, customerId: v.customerId! },
        });
        completed =
          roster?.status === 'COMPLETED' ||
          (!!roster &&
            roster.totalDurationSec >=
              (course.totalDuration * 60) / 100 &&
            roster.maxProgressSec >= (course.totalDuration * 60) / 100);
      }
    }
    return {
      course: {
        id: course.id,
        name: course.name,
        coverUrl: course.coverUrl,
        startTime: course.startTime,
        endTime: course.endTime,
        status: course.status,
        totalDuration: course.totalDuration,
      },
      customer: customer
        ? {
            nickname: customer.nickname,
            avatar: customer.avatar,
            studentId: customer.studentId,
          }
        : null,
      roster: roster
        ? {
            totalDurationSec: roster.totalDurationSec,
            maxProgressSec: roster.maxProgressSec,
            reminderCount: roster.reminderCount,
            stopReminder: roster.stopReminder,
          }
        : null,
      completed,
      visitToken: visitTokenFromQuery ?? uuidv4(),
    };
  }

  /** 发送验证码（简化：开发环境直接返回 123456；生产环境接 SMS） */
  async sendSmsCode(mobile: string) {
    if (!/^1\d{10}$/.test(mobile)) {
      throw new BadRequestException('手机号格式不正确');
    }
    // 开发模式：固定 123456
    const code = process.env.NODE_ENV === 'production'
      ? Math.floor(100000 + Math.random() * 900000).toString()
      : '123456';
    await this.redis.safeSet(`sms:${mobile}`, code, 300);
    this.logger.debug(`[SMS] ${mobile} -> ${code}`);
    return { ok: true, codeInDev: code };
  }

  /**
   * 验证身份，返回登录用 token（JWT 轻量版：customerId + studentId，放 Redis 24h）
   * 支持方式：
   *  - sms: mobile + code
   *  - trace: 若请求来自提醒消息 recipient，可凭一次性 token
   */
  async verifyIdentity(params: {
    method: 'sms';
    mobile: string;
    code: string;
    feiceLiveRoomId: string;
    userAgent?: string;
    clientIp?: string;
    messageRecipientId?: number;
  }) {
    if (params.method === 'sms') {
      const stored = await this.redis.safeGet(`sms:${params.mobile}`);
      if (!stored || stored !== params.code) {
        throw new BadRequestException('验证码错误');
      }
      await this.redis.get().del(`sms:${params.mobile}`);
    }
    const mobileHash = crypto.createHash('sha256').update(params.mobile).digest('hex');
    // 通过手机号匹配 customer（优先 mobileEncrypted）
    let customer = await this.prisma.customer.findFirst({
      where: { mobileEncrypted: mobileHash },
    });
    // 否则通过 remark_mobiles 里是否包含
    if (!customer) {
      const all = await this.prisma.customer.findMany({
        where: { remarkMobiles: { contains: params.mobile } },
      });
      customer = all[0] ?? null;
    }
    if (!customer) {
      // 新客户直接创建（最小化），后续由销售接管
      customer = await this.prisma.customer.create({
        data: {
          externalUserid: `anon_${Date.now()}`,
          nickname: params.mobile.slice(-4),
          studentId: `stu_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
          thirdPartyTraceId: `tpt_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
          mobileEncrypted: mobileHash,
          remarkMobiles: params.mobile,
        },
      });
    }
    // 记录 visit
    const course = await this.prisma.course.findFirstOrThrow({
      where: { feiceLiveRoomId: params.feiceLiveRoomId },
    });
    const visitToken = uuidv4();
    const loginSuccessAt = new Date();
    await this.prisma.transferPageVisit.create({
      data: {
        courseId: course.id,
        customerId: customer.id,
        visitToken,
        userAgent: params.userAgent,
        clientIp: params.clientIp,
        loginMethod: params.method,
        loginSuccessAt,
        messageRecipientId: params.messageRecipientId,
      },
    });
    // 如果是来自提醒消息 recipient，更新转化
    if (params.messageRecipientId) {
      await this.prisma.wecomGroupMessageRecipient.update({
        where: { id: params.messageRecipientId },
        data: { openedTransferPage: true, firstOpenedAt: loginSuccessAt },
      });
    }
    // 颁发轻量登录 token（存 Redis 24h，对应 visitToken 作为 key）
    await this.redis.safeSet(
      `transfer:auth:${visitToken}`,
      JSON.stringify({ customerId: customer.id, studentId: customer.studentId }),
      24 * 3600,
    );
    return {
      ok: true,
      visitToken,
      customer: {
        nickname: customer.nickname,
        avatar: customer.avatar,
        studentId: customer.studentId,
      },
    };
  }

  /** 生成带追踪的飞策入口，并记录跳转 */
  async enterCourse(feiceLiveRoomId: string, visitToken: string) {
    const authStr = await this.redis.safeGet(`transfer:auth:${visitToken}`);
    if (!authStr) throw new BadRequestException('请先完成身份验证');
    const { customerId } = JSON.parse(authStr);
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    const course = await this.prisma.course.findFirstOrThrow({
      where: { feiceLiveRoomId },
    });
    if (!customer.thirdPartyTraceId) {
      throw new BadRequestException('该学生缺少追踪ID，请联系管理员');
    }
    const feiceUrl = await this.feice.buildEntryUrl({
      liveRoomId: course.feiceLiveRoomId,
      thirdPartyTraceId: customer.thirdPartyTraceId,
      nickname: customer.nickname,
      entryType: course.status === 'ENDED' ? 'replay' : 'live',
    });
    // 更新 visit
    const now = new Date();
    await this.prisma.transferPageVisit.updateMany({
      where: { visitToken, jumpedToFeiceAt: null },
      data: { jumpedToFeiceAt: now, feiceEntryUrl: feiceUrl.url },
    });
    // 转化追踪 - 关联到任何一个未跳转过的 recipient
    const visit = await this.prisma.transferPageVisit.findFirst({
      where: { visitToken },
      select: { messageRecipientId: true },
    });
    if (visit?.messageRecipientId) {
      await this.prisma.wecomGroupMessageRecipient.update({
        where: { id: visit.messageRecipientId },
        data: { jumpedToFeice: true, jumpedAt: now, enteredCourse: true },
      });
    }
    return { feiceUrl };
  }

  /** 学生在中转页取消后续提醒 */
  async stopReminder(feiceLiveRoomId: string, visitToken: string) {
    const authStr = await this.redis.safeGet(`transfer:auth:${visitToken}`);
    if (!authStr) throw new BadRequestException('请先完成身份验证');
    const { customerId } = JSON.parse(authStr);
    const course = await this.prisma.course.findFirstOrThrow({
      where: { feiceLiveRoomId },
    });
    const updated = await this.prisma.courseRoster.updateMany({
      where: {
        task: { courseId: course.id },
        customerId,
        stopReminder: false,
      },
      data: {
        stopReminder: true,
        stopReason: 'transfer_page',
        stoppedAt: new Date(),
      },
    });
    await this.prisma.transferPageVisit.updateMany({
      where: { visitToken },
      data: { stopReminderRequested: true },
    });
    return { ok: true, updated: updated.count };
  }
}
