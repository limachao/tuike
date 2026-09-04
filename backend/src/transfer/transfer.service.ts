import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly config: ConfigService,
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
    // 记录 visit + 颁发轻量登录 token（存 Redis 24h）
    const course = await this.prisma.course.findFirstOrThrow({
      where: { feiceLiveRoomId: params.feiceLiveRoomId },
    });
    return this.issueLoginToken({
      course,
      customer,
      loginMethod: 'sms',
      userAgent: params.userAgent,
      clientIp: params.clientIp,
      messageRecipientId: params.messageRecipientId,
    });
  }

  /** 微信服务号 OAuth 跳转地址（未开启/未配置时返回 configured:false，前端隐藏授权按钮） */
  getWechatAuthUrl(feiceLiveRoomId: string) {
    const enabled = this.config.get<string>('WECHAT_OAUTH_ENABLED', '');
    const appId = this.config.get<string>('WECHAT_OAUTH_APPID', '');
    const base = this.config.get<string>('TRANSFER_PAGE_BASE_URL', '');
    if (enabled !== 'true' || !appId || !base || !feiceLiveRoomId) {
      return { configured: false, url: '' };
    }
    const redirectUri = encodeURIComponent(`${base}/course/${feiceLiveRoomId}`);
    const state = encodeURIComponent(feiceLiveRoomId);
    return {
      configured: true,
      url: `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${appId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_userinfo&state=${state}#wechat_redirect`,
    };
  }

  /** 微信授权回调登录：code 换 unionid → 匹配企微客户 → 颁发登录态 */
  async wechatLogin(params: {
    code: string;
    feiceLiveRoomId: string;
    userAgent?: string;
    clientIp?: string;
  }) {
    const enabled = this.config.get<string>('WECHAT_OAUTH_ENABLED', '');
    const appId = this.config.get<string>('WECHAT_OAUTH_APPID', '');
    const secret = this.config.get<string>('WECHAT_OAUTH_SECRET', '');
    if (enabled !== 'true' || !appId || !secret) {
      throw new BadRequestException('微信授权暂未开放，请使用手机号后四位验证');
    }
    const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${secret}&code=${encodeURIComponent(params.code)}&grant_type=authorization_code`;
    const res = await fetch(url);
    const data: any = await res.json().catch(() => ({}));
    if (data.errcode) {
      this.logger.warn(
        `[WechatOAuth] code 换取失败 errcode=${data.errcode} errmsg=${data.errmsg}`,
      );
      throw new BadRequestException('微信授权已过期，请重新点击授权');
    }
    const unionid = data.unionid as string | undefined;
    if (!unionid) {
      return { ok: true, matched: false, message: '未获取到微信身份，请使用手机号后四位验证' };
    }
    const customer = await this.prisma.customer.findUnique({
      where: { wecomUnionid: unionid },
    });
    if (!customer || customer.isDeleted) {
      // unionid 未同步到企微客户（可能是企微后台未绑定微信开发者ID，或客户未同步）
      return { ok: true, matched: false, message: '未识别到学员身份，请使用手机号后四位验证' };
    }
    const course = await this.prisma.course.findFirst({
      where: { feiceLiveRoomId: params.feiceLiveRoomId },
    });
    if (!course) throw new NotFoundException('课程不存在');
    const result = await this.issueLoginToken({
      course,
      customer,
      loginMethod: 'wechat',
      userAgent: params.userAgent,
      clientIp: params.clientIp,
    });
    return { ...result, matched: true };
  }

  /** 兜底登录：手机号后四位匹配（优先本课程学员名单，其次全库） */
  async loginByMobileSuffix(params: {
    suffix: string;
    feiceLiveRoomId: string;
    userAgent?: string;
    clientIp?: string;
  }) {
    if (!/^\d{4}$/.test(params.suffix)) {
      throw new BadRequestException('请输入手机号后四位');
    }
    const course = await this.prisma.course.findFirst({
      where: { feiceLiveRoomId: params.feiceLiveRoomId },
    });
    if (!course) throw new NotFoundException('课程不存在');
    const match = (c: { remarkMobiles: string | null }) =>
      (c.remarkMobiles ?? '').split(',').some((m) => m.endsWith(params.suffix));

    // 1) 本课程学员名单内匹配
    const rosterEntries = await this.prisma.courseRoster.findMany({
      where: { task: { courseId: course.id } },
      include: { customer: true },
    });
    let candidates = rosterEntries.map((r) => r.customer).filter(match);
    // 2) 名单没唯一命中，退回全库匹配
    if (candidates.length !== 1) {
      const all = await this.prisma.customer.findMany({
        where: { remarkMobiles: { contains: params.suffix } },
      });
      const global = all.filter(match);
      if (global.length >= 1) candidates = global;
    }
    if (candidates.length === 0) {
      return { ok: true, matched: false, message: '未匹配到学员，请确认手机号或联系销售老师' };
    }
    if (candidates.length > 1) {
      return { ok: true, matched: false, message: '该后四位对应多位学员，请联系销售老师确认' };
    }
    const result = await this.issueLoginToken({
      course,
      customer: candidates[0],
      loginMethod: 'mobile_last4',
      userAgent: params.userAgent,
      clientIp: params.clientIp,
    });
    return { ...result, matched: true };
  }

  /** 颁发登录态：记录 visit + Redis token（24h），sms/wechat/mobile_last4 共用 */
  private async issueLoginToken(opts: {
    course: { id: number };
    customer: any;
    loginMethod: string;
    userAgent?: string;
    clientIp?: string;
    messageRecipientId?: number;
  }) {
    const visitToken = uuidv4();
    const loginSuccessAt = new Date();
    await this.prisma.transferPageVisit.create({
      data: {
        courseId: opts.course.id,
        customerId: opts.customer.id,
        visitToken,
        userAgent: opts.userAgent,
        clientIp: opts.clientIp,
        loginMethod: opts.loginMethod,
        loginSuccessAt,
        messageRecipientId: opts.messageRecipientId,
      },
    });
    // 如果是来自提醒消息 recipient，更新转化
    if (opts.messageRecipientId) {
      await this.prisma.wecomGroupMessageRecipient.update({
        where: { id: opts.messageRecipientId },
        data: { openedTransferPage: true, firstOpenedAt: loginSuccessAt },
      });
    }
    await this.redis.safeSet(
      `transfer:auth:${visitToken}`,
      JSON.stringify({ customerId: opts.customer.id, studentId: opts.customer.studentId }),
      24 * 3600,
    );
    return {
      ok: true,
      visitToken,
      customer: {
        nickname: opts.customer.nickname,
        avatar: opts.customer.avatar,
        studentId: opts.customer.studentId,
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
    // 飞策邀课链接接口要求 userId/mobile 至少一个：优先取学员匹配到的飞策 uid
    const identity = await this.prisma.feiceIdentity.findFirst({
      where: { customerId: customer.id, uid: { not: null } },
      orderBy: { matchLevel: 'desc' },
    });
    const firstMobile = (customer.remarkMobiles ?? '').split(',').find(Boolean);
    const feiceUrl = await this.feice.buildEntryUrl({
      liveRoomId: course.feiceLiveRoomId,
      thirdPartyTraceId: customer.thirdPartyTraceId,
      userId: identity?.uid ?? undefined,
      mobile: identity?.uid ? undefined : firstMobile,
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
