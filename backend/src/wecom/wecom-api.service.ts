import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis/redis.service';

/**
 * 企业微信 API 客户端 - 客户联系相关
 *
 * 核心接口：
 * - 获取 access_token (缓存)
 * - 获取配置了客户联系功能的成员列表
 * - 获取成员客户列表 (external_userid 列表)
 * - 获取客户详情（含 remark_mobiles、标签等）
 * - 获取客户群列表
 * - 创建客户联系「联系我」方式（后续版本）
 * - 创建群发消息任务
 * - 查询群发任务执行状态
 * - 查询客户级发送结果
 * - 停止群发任务
 *
 * 注意：所有接口遵循官方频率限制，出错重试指数退避。
 */
@Injectable()
export class WecomApiService implements OnModuleInit {
  private readonly logger = new Logger(WecomApiService.name);
  private corpId: string;
  private contactSecret: string;
  private baseUrl = 'https://qyapi.weixin.qq.com';

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.corpId = this.config.get<string>('WECOM_CORP_ID', '');
    this.contactSecret = this.config.get<string>('WECOM_CONTACT_SECRET', '');
  }

  onModuleInit() {
    if (!this.corpId || !this.contactSecret) {
      this.logger.warn('企业微信 CorpID/Secret 未配置，模块将以Mock模式运行。');
    }
  }

  private isMock() {
    return !this.corpId || !this.contactSecret;
  }

  /** 获取客户联系 access_token，缓存 2 小时 */
  async getContactAccessToken(): Promise<string> {
    if (this.isMock()) return 'mock-wecom-token';
    const cacheKey = 'wecom:token:contact';
    const hit = await this.redis.safeGet(cacheKey);
    if (hit) return hit;
    const url = `${this.baseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(
      this.corpId,
    )}&corpsecret=${encodeURIComponent(this.contactSecret)}`;
    const data = await this.requestJson<any>(url, 'GET', null, true);
    const token = data.access_token;
    const expiresIn = Math.max(Number(data.expires_in ?? 7200) - 300, 100);
    await this.redis.safeSet(cacheKey, token, expiresIn);
    return token;
  }

  // ============= 成员与客户 =============

  /** 获取配置了客户联系功能的成员列表 */
  async listContactUsers(): Promise<
    Array<{ userid: string; name?: string; status?: number }>
  > {
    if (this.isMock()) return [];
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/get_follow_user_list?access_token=${token}`;
    const r = await this.requestJson<any>(url, 'GET');
    return r.follow_user ?? [];
  }

  /** 获取指定成员的客户 external_userid 列表 */
  async listCustomerExternalIds(
    wecomUserId: string,
  ): Promise<Array<{ external_userid: string }>> {
    if (this.isMock()) return [];
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/list?access_token=${token}&userid=${encodeURIComponent(
      wecomUserId,
    )}`;
    const r = await this.requestJson<any>(url, 'GET');
    return r.external_userid?.map((id: string) => ({ external_userid: id })) ?? [];
  }

  /**
   * 批量获取指定成员的客户详情（含 external_contact + follow_info）
   * 每页最多 100 条，用 next_cursor 翻页
   */
  async getCustomersByUser(
    userid: string,
    cursor?: string,
    limit = 100,
  ): Promise<{ list: any[]; nextCursor?: string }> {
    if (this.isMock()) return { list: [] };
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/batch/get_by_user?access_token=${token}`;
    const body: any = { userid, limit };
    if (cursor) body.cursor = cursor;
    const r = await this.requestJson<any>(url, 'POST', body);
    return {
      list: r.external_contact_list ?? [],
      nextCursor: r.next_cursor || undefined,
    };
  }

  /** 获取单个客户详情（含添加方式等） */
  async getCustomerDetail(externalUserid: string, cursor?: string) {
    if (this.isMock()) return null;
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/get?access_token=${token}&external_userid=${encodeURIComponent(
      externalUserid,
    )}`;
    return this.requestJson<any>(url, 'GET');
  }

  // ============= 群发消息 =============

  /**
   * 创建企业微信群发消息任务（仅创建，不会直接发送；销售需在客户端确认）
   * 注意：官方规定单次最多 10000 个客户；一个任务统一文案统一链接。
   */
  async createGroupMessageTask(input: {
    senderWecomUserId: string;
    externalUserIds: string[];
    textContent: string;
    linkUrl: string;
    linkTitle?: string;
    linkPic?: string;
    linkDesc?: string;
  }): Promise<{ msgid: string; failList?: string[] }> {
    if (this.isMock()) {
      // Mock 模式下直接生成假 msgid
      return {
        msgid: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      };
    }
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/add_msg_template?access_token=${token}`;
    const body: any = {
      chat_type: 'single',
      external_userid: input.externalUserIds,
      sender: input.senderWecomUserId,
      text: { content: input.textContent },
    };
    if (input.linkUrl) {
      const publicBase =
        process.env.PUBLIC_BASE_URL ?? 'https://tuike.liangjieke.com';
      body.link = {
        title: input.linkTitle ?? '课程入口',
        // 链接卡片封面：默认用品牌封面图（frontend/public/brand-cover.jpg）
        picurl: input.linkPic ?? `${publicBase}/brand-cover.jpg`,
        desc: input.linkDesc ?? '点击进入课程学习',
        url: input.linkUrl,
      };
    }
    const r = await this.requestJson<any>(url, 'POST', body);
    return {
      msgid: r.msgid,
      failList: r.fail_list,
    };
  }

  /** 查询群发任务成员执行状态（是否确认发送） */
  async queryGroupMessageSendStatus(msgid: string) {
    if (this.isMock()) return { detail: [], total: 0 };
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/get_groupmsg_task?access_token=${token}`;
    return this.requestJson<any>(url, 'POST', { msgid });
  }

  /** 查询群发任务客户级发送结果（分页） */
  async queryGroupMessageCustomerResult(msgid: string, limit = 500, cursor?: string) {
    if (this.isMock()) return { sent_list: [], fail_list: [], next_cursor: undefined };
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/get_groupmsg_send_result?access_token=${token}`;
    const body: any = { msgid, limit };
    if (cursor) body.cursor = cursor;
    return this.requestJson<any>(url, 'POST', body);
  }

  /** 停止尚未执行完的群发任务 */
  async cancelGroupMessage(msgid: string) {
    if (this.isMock()) return {};
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/cancel_groupmsg_send?access_token=${token}`;
    return this.requestJson<any>(url, 'POST', { msgid });
  }

  // ============= 通用 HTTP =============
  private async requestJson<T>(
    url: string,
    method: 'GET' | 'POST',
    body?: any,
    skipTokenCheck = false,
    retryCount = 0,
  ): Promise<T> {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      // 企业微信 429 / token 失效处理
      if (data && typeof data === 'object' && 'errcode' in data) {
        const code = Number(data.errcode);
        if (code === 0) return data;
        if (code === 40014 && !skipTokenCheck && retryCount === 0) {
          // token 失效，刷新后重试一次
          await this.redis.get().del('wecom:token:contact');
          return this.requestJson<T>(url, method, body, false, retryCount + 1);
        }
        if (code === 429 || code === 45009) {
          if (retryCount < 3) {
            const wait = Math.pow(2, retryCount + 1) * 500;
            await sleep(wait);
            return this.requestJson<T>(url, method, body, skipTokenCheck, retryCount + 1);
          }
        }
        throw new Error(
          `[WeCom errcode=${code}] ${data.errmsg ?? 'unknown error'}`,
        );
      }
      return data as T;
    } catch (e: any) {
      if (e instanceof Error && e.message.includes('errcode')) throw e;
      if (retryCount < 3) {
        const wait = Math.pow(2, retryCount + 1) * 500;
        await sleep(wait);
        return this.requestJson<T>(url, method, body, skipTokenCheck, retryCount + 1);
      }
      throw e;
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
