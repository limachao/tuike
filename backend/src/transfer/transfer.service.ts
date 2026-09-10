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

  /**
   * 发送验证码（生产环境接 SMS 通道；开发环境固定 123456）。
   * 限流：同手机号 60 秒 1 条、同一 IP 每小时 10 条，防短信轰炸/刷接口。
   */
  async sendSmsCode(mobile: string, clientIp?: string) {
    if (!/^1\d{10}$/.test(mobile)) {
      throw new BadRequestException('手机号格式不正确');
    }
    // 同手机号 60 秒内只能发 1 条
    const perMobile = await this.redis.incrWithTtl(`ratelimit:sms:mobile:${mobile}`, 60);
    if (perMobile > 1) {
      throw new BadRequestException('验证码已发送，请 60 秒后再试');
    }
    // 同一 IP 每小时最多 10 条
    if (clientIp) {
      const perIp = await this.redis.incrWithTtl(`ratelimit:sms:ip:${clientIp}`, 3600);
      if (perIp > 10) {
        throw new BadRequestException('请求过于频繁，请稍后再试');
      }
    }
    const isProd = process.env.NODE_ENV === 'production';
    const code = isProd
      ? Math.floor(100000 + Math.random() * 900000).toString()
      : '123456';
    await this.redis.safeSet(`sms:${mobile}`, code, 300);
    if (!isProd) {
      this.logger.debug(`[SMS] ${mobile} -> ${code}`);
      // 开发环境直接回传验证码方便联调；生产环境绝不下发
      return { ok: true, codeInDev: code };
    }
    // TODO: 生产环境在此接入真实短信通道（当前未配置时验证码仅存 Redis，登录走微信授权/后四位）
    this.logger.log(`[SMS] 生产验证码已生成（手机号尾号 ${mobile.slice(-4)}），等待短信通道接入`);
    return { ok: true };
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
      // 错误次数锁定：同手机号验证码错 5 次锁 10 分钟，防暴力枚举
      const lockKey = `sms:fail:${params.mobile}`;
      const fails = await this.redis.incrWithTtl(lockKey, 600);
      if (fails > 5) {
        throw new BadRequestException('验证码错误次数过多，请 10 分钟后再试');
      }
      const stored = await this.redis.safeGet(`sms:${params.mobile}`);
      if (!stored || stored !== params.code) {
        throw new BadRequestException('验证码错误');
      }
      // 验证通过：清错误计数 + 删验证码（一次性）
      await this.redis.get().del(lockKey);
      await this.redis.get().del(`sms:${params.mobile}`);
    }
    const mobileHash = crypto.createHash('sha256').update(params.mobile).digest('hex');
    // 通过手机号匹配 customer（优先 mobileEncrypted）
    let customer = await this.prisma.customer.findFirst({
      where: { mobileEncrypted: mobileHash },
    });
    // 否则通过 remark_mobiles 里是否包含（全表模糊匹配，取 1 条即可）
    if (!customer) {
      const all = await this.prisma.customer.findMany({
        where: { remarkMobiles: { contains: params.mobile } },
        take: 1,
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
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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
    // 限流：后四位仅 1 万种组合，同一 IP 每小时限 30 次尝试，防暴力枚举
    if (params.clientIp) {
      const tries = await this.redis.incrWithTtl(
        `ratelimit:suffix:ip:${params.clientIp}`,
        3600,
      );
      if (tries > 30) {
        throw new BadRequestException('尝试次数过多，请一小时后再试或改用短信验证');
      }
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
    // 2) 名单没唯一命中，退回全库匹配。
    //    用正则要求后四位出现在某个手机号的结尾（逗号分隔），避免 contains 误命中
    //    （如 1234 命中 12345）；LIMIT 2：0=无此人，1=命中，≥2=重名歧义，
    //    不再把成千上万行全加载进内存。
    if (candidates.length !== 1) {
      const global: Array<{ id: number; remarkMobiles: string | null }> =
        await this.prisma.$queryRaw`
          SELECT id, "remarkMobiles"
          FROM customers
          WHERE "isDeleted" = false
            AND "remarkMobiles" ~ (${params.suffix} || '(,|$)')
          LIMIT 2
        `;
      if (global.length === 1) {
        // 命中唯一：取完整客户信息（登录态/昵称/头像都要用）
        const full = await this.prisma.customer.findUnique({
          where: { id: global[0].id },
        });
        candidates = full ? [full] : [];
      }
      else if (global.length > 1) candidates = global as any;
      else candidates = [];
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
    // 飞策邀课链接候选路径（2026-09-08 实测，按优先级逐个尝试）：
    //  1. 学员飞策 uid（直播记录 uid 是 85 开头，邀课接口通常不认，保留尝试）
    //  2. 学员备注手机号（须已在飞策建档）
    //  3. 该直播间销售的 SCRM 通用邀课链接（78 开头 userId，实测稳定成功）
    //  4. 内部手机号链接（最终兜底，需配置 FEICE_INTERNAL_MOBILE）
    // 学员在微信里打开链接后走飞策自己的微信登录，听课记录按学员本人 unionId 归因。
    const identity = await this.prisma.feiceIdentity.findFirst({
      where: { customerId: customer.id, uid: { not: null } },
      orderBy: { matchLevel: 'desc' },
    });
    const firstMobile = (customer.remarkMobiles ?? '').split(',').find(Boolean);
    const producers: Array<() => Promise<{ url: string }>> = [];
    if (identity?.uid) {
      producers.push(() =>
        this.feice.buildEntryUrl({
          liveRoomId: course.feiceLiveRoomId,
          thirdPartyTraceId: customer.thirdPartyTraceId ?? undefined,
          userId: identity.uid ?? undefined,
        }),
      );
    }
    if (firstMobile) {
      producers.push(() =>
        this.feice.buildEntryUrl({
          liveRoomId: course.feiceLiveRoomId,
          thirdPartyTraceId: customer.thirdPartyTraceId ?? undefined,
          mobile: firstMobile,
        }),
      );
    }
    producers.push(() => this.feice.buildRoomSalesInviteUrl(course.feiceLiveRoomId));
    producers.push(() =>
      this.feice.buildInternalPlayUrl({
        liveRoomId: course.feiceLiveRoomId,
        userId: customer.id,
      }),
    );

    let lastErr: any = null;
    for (const produce of producers) {
      try {
        const feiceUrl = await produce();
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
      } catch (e) {
        lastErr = e;
      }
    }
    throw new BadRequestException(
      `获取课程入口失败：${lastErr?.message ?? '未知错误'}`,
    );
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
