import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * 飞策开放平台 API 客户端
 *
 * 鉴权方式（文档确认 2026-09-03 + 实测验证）：
 *   每次请求带 4 个通用参数：appId / ts / nonce / sign
 *
 *   签名串 = 所有请求参数（不含 sign 本身）按 key 字典序排序后
 *            **直接拼接成 "key1=value1key2=value2key3=value3..."**
 *            （⚠️ 无 & 分隔符！实测验证通过）
 *   sign  = HMAC-SHA256(签名串, appSecret).toHexLowerCase()
 *
 *   业务接口：
 *   - 直播列表 GET /live-manage/open/live-room/list
 *     必填：startTime（毫秒时间戳）, offset（偏移量，每次+20）
 *   - 邀课记录 GET /live-manage/open/invitation-record/list
 *
 * 正式环境 BaseURL: https://scrm.gzfeice.com/api
 */
@Injectable()
export class FeiceApiService implements OnModuleInit {
  private readonly logger = new Logger(FeiceApiService.name);

  private appId: string;
  private appSecret: string;
  private baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('FEICE_APP_ID', '');
    this.appSecret = this.config.get<string>('FEICE_APP_SECRET', '');
    this.baseUrl = this.config.get<string>(
      'FEICE_BASE_URL',
      'https://scrm.gzfeice.com/api',
    );
  }

  onModuleInit() {
    if (!this.appId || !this.appSecret) {
      this.logger.warn('飞策 appId/Secret 未配置，模块将以 Mock 模式运行。');
    } else {
      this.logger.log(`飞策 API 已就绪：${this.baseUrl}`);
    }
  }

  private isMock() {
    return !this.appId || !this.appSecret;
  }

  // ========== 签名工具（严格按飞策文档） ==========

  /** 生成 10 位数字字母随机串 */
  private genNonce(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 10; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  /** 毫秒时间戳 */
  private genTs(): string {
    return Date.now().toString();
  }

  /**
   * 计算签名
   *
   * ⚠️ 实测验证：签名串是 key=value 直接连（无 &），按字典序排序
   * @param allParams 所有请求参数（包含 appId/ts/nonce + 业务参数），不含 sign 本身
   * @returns HMAC-SHA256 十六进制小写
   */
  private sign(allParams: Record<string, string>): string {
    const sortedKeys = Object.keys(allParams).sort();
    // ⚠️ 无分隔符！key=value 直接拼接
    const signSource = sortedKeys
      .map((k) => `${k}=${allParams[k]}`)
      .join('');

    this.logger.debug(`[Feice Sign] source = ${signSource}`);

    const hmac = crypto.createHmac('sha256', this.appSecret);
    hmac.update(signSource, 'utf8');
    return hmac.digest('hex');
  }

  /** 构造最终请求 query（含 sign） */
  private buildSignedQuery(extraQuery: Record<string, string>): Record<string, string> {
    const ts = this.genTs();
    const nonce = this.genNonce();

    const all: Record<string, string> = {
      appId: this.appId,
      ts,
      nonce,
      ...extraQuery,
    };

    // sign 由所有其他参数算出，自己不参与
    all.sign = this.sign({ ...all });
    return all;
  }

  // ========== 已确认接口 ==========

  /**
   * 课程/直播间列表
   * 必填：startTime（毫秒时间戳）, offset（偏移量，每次+20）
   * ⚠️ 飞策限制 startTime 不能超过 29 天前，也不能是未来时间
   */
  async listLiveRooms(params: { startTime?: number; offset?: number } = {}) {
    if (this.isMock()) return { list: [], total: 0 };

    const path = '/live-manage/open/live-room/list';
    // 飞策限制：startTime 不能 > 29 天前，也不能是未来时间
    // 用「现在 - 1 毫秒」最安全，查未来 + 正在进行的直播
    const now = Date.now();
    const maxPast = now - 29 * 24 * 3600 * 1000;
    const userStart = params.startTime ?? (now - 1);
    const startTime = String(Math.max(userStart, maxPast));
    const offset = String(params.offset ?? 0);

    const r = await this.signedRequest<any>('GET', path, { startTime, offset });
    return {
      list: r.data?.list ?? r.data?.records ?? r.list ?? [],
      total: r.data?.total ?? r.data?.count ?? 0,
    };
  }

  /** 邀课记录列表 */
  async listInviteRecords(params: {
    liveRoomId?: string;
    offset?: number;
    startTime?: number;
  } = {}) {
    if (this.isMock()) return { list: [], total: 0 };

    const path = '/live-manage/open/invitation-record/list';
    const now = Date.now();
    const maxPast = now - 29 * 24 * 3600 * 1000;
    const userStart = params.startTime ?? (now - 1);
    const extra: Record<string, string> = {
      offset: String(params.offset ?? 0),
      startTime: String(Math.max(userStart, maxPast)),
    };
    if (params.liveRoomId) extra.liveRoomId = params.liveRoomId;

    const r = await this.signedRequest<any>('GET', path, extra);
    return {
      list: r.data?.list ?? r.list ?? [],
      total: r.data?.total ?? 0,
    };
  }

  /** 直播观看记录 GET /live-manage/open/class-record/list */
  async listLiveWatchRecords(params: {
    liveRoomId?: string;
    liveId?: string;
    offset?: number;
    startTime?: number;
  } = {}) {
    if (this.isMock()) return { list: [], total: 0 };

    const path = '/live-manage/open/class-record/list';
    const now = Date.now();
    const maxPast = now - 29 * 24 * 3600 * 1000;
    const userStart = params.startTime ?? (now - 1);
    const extra: Record<string, string> = {
      offset: String(params.offset ?? 0),
      startTime: String(Math.max(userStart, maxPast)),
    };
    if (params.liveRoomId) extra.liveRoomId = params.liveRoomId;
    if (params.liveId) extra.liveId = params.liveId;

    const r = await this.signedRequest<any>('GET', path, extra);
    return {
      list: r.data?.list ?? r.data?.records ?? r.list ?? [],
      total: r.data?.total ?? 0,
    };
  }

  /** 回放观看记录 GET /live-manage/open/live-playback-record/list */
  async listReplayWatchRecords(params: {
    liveRoomId?: string;
    offset?: number;
    startTime?: number;
  } = {}) {
    if (this.isMock()) return { list: [], total: 0 };

    const path = '/live-manage/open/live-playback-record/list';
    const now = Date.now();
    const maxPast = now - 29 * 24 * 3600 * 1000;
    const userStart = params.startTime ?? (now - 1);
    const extra: Record<string, string> = {
      offset: String(params.offset ?? 0),
      startTime: String(Math.max(userStart, maxPast)),
    };
    if (params.liveRoomId) extra.liveRoomId = params.liveRoomId;

    const r = await this.signedRequest<any>('GET', path, extra);
    return {
      list: r.data?.list ?? r.data?.records ?? r.list ?? [],
      total: r.data?.total ?? 0,
    };
  }

  /**
   * 获取邀课链接 GET /live-manage/open/invitation-link/list
   * 文档（2026-09-04 实读）：
   *  - liveRoomId 必填；userId/mobile 不能同时为空（都传以 userId 为准）
   *  - thirdPartyTraceId 选填（≤32位），飞策会自动拼到邀课链接上用于透传
   *  - 响应 data[]: { liveRoomId, inviteLink, tagName, tags[], createdDt, updatedDt }
   */
  async generateInviteUrl(params: {
    liveRoomId: string;
    userId?: string;
    mobile?: string;
    thirdPartyTraceId?: string;
  }) {
    if (this.isMock()) {
      return {
        url: `https://example.com/mock-invite?thirdPartyTraceId=${params.thirdPartyTraceId ?? ''}`,
        thirdPartyTraceId: params.thirdPartyTraceId ?? '',
      };
    }
    if (!params.userId && !params.mobile) {
      throw new Error('获取邀课链接需要飞策 userId 或 mobile 至少一个');
    }
    const extra: Record<string, string> = { liveRoomId: params.liveRoomId };
    if (params.userId) extra.userId = params.userId;
    if (params.mobile) extra.mobile = params.mobile;
    if (params.thirdPartyTraceId) extra.thirdPartyTraceId = params.thirdPartyTraceId.slice(0, 32);

    const r = await this.signedRequest<any>('GET', '/live-manage/open/invitation-link/list', extra);
    const list = Array.isArray(r.data) ? r.data : r.data?.list ?? [];
    const item = list[0];
    if (!item?.inviteLink) {
      throw new Error('飞策未返回邀课链接（该直播间可能尚未创建邀课链接）');
    }
    return { url: item.inviteLink, thirdPartyTraceId: params.thirdPartyTraceId ?? '' };
  }

  // ========== 通用请求（带签名） ==========

  private async signedRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    extraQuery: Record<string, string> = {},
    body?: any,
  ): Promise<T> {
    const authQuery = this.buildSignedQuery(extraQuery);
    const qs = Object.keys(authQuery)
      .map((k) => `${k}=${encodeURIComponent(authQuery[k])}`)
      .join('&');

    const url = `${this.baseUrl}${path}?${qs}`;

    this.logger.log(`[Feice] ${method} ${path}?appId=***&ts=${authQuery.ts}`);

    try {
      // 15 秒超时：避免飞策无响应时请求永久挂起（undici 默认超时长达 5 分钟）
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15000),
        });
      } catch (e: any) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
          throw new Error('飞策接口请求超时（15秒无响应），请稍后重试');
        }
        throw e;
      }

      const text = await res.text().catch(() => '');
      this.logger.log(`[Feice] ${path} 响应 HTTP ${res.status}: ${text.slice(0, 200)}`);
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (!res.ok) {
        this.logger.error(`[Feice HTTP ${res.status}] ${path} -> ${text.slice(0, 300)}`);
        throw new Error(`飞策接口错误 HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      // 飞策常见业务错误码
      if (data && typeof data.code !== 'undefined' && data.code !== 0 && data.code !== 200) {
        this.logger.error(`[Feice BIZ] ${path} code=${data.code} msg=${data.msg ?? data.message ?? ''}`);
        throw new Error(`飞策业务错误 [${data.code}]: ${data.msg ?? data.message ?? '未知错误'}`);
      }

      return data as T;
    } catch (e: any) {
      this.logger.error(`[Feice] ${method} ${path} 失败: ${e.message}`);
      throw e;
    }
  }
}
