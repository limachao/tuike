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

  /**
   * 获取客户标签库（返回 tagId → {name, group} 映射）。
   *
   * 注意：教育版企微（行业版）用 get_corp_tag_list，标准版用 list_tag。
   * 教育版如果调 list_tag 会返回空响应体（不是错误码，是纯空字符串），
   * 所以优先试 get_corp_tag_list，失败再回退 list_tag。
   */
  async listCustomerTags(): Promise<Map<string, { name: string; group: string }>> {
    if (this.isMock()) return new Map();
    const token = await this.getContactAccessToken();
    const map = new Map<string, { name: string; group: string }>();
    // 优先教育版接口
    const candidates = [
      '/cgi-bin/externalcontact/get_corp_tag_list',
      '/cgi-bin/externalcontact/list_tag?type=2',
    ];
    for (const path of candidates) {
      try {
        const url = `${this.baseUrl}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
        const r = await this.requestJson<any>(url, 'GET');
        if (r?.tag_group?.length) {
          for (const group of r.tag_group) {
            for (const tag of group.tag ?? []) {
              if (tag?.id && tag?.name) {
                map.set(String(tag.id), {
                  name: String(tag.name),
                  group: String(group.group_name ?? ''),
                });
              }
            }
          }
          if (map.size) break; // 有数据就停
        }
      } catch {
        // 某个接口失败继续试下一个
      }
    }
    return map;
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
        // 链接卡片封面：默认用品牌封面图（frontend/public/brand-cover-v2.jpg）
        // 注：微信按 URL 缓存封面，换图必须换文件名
        picurl: input.linkPic ?? `${publicBase}/brand-cover-v2.jpg`,
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

  /**
   * 通过 get_groupmsg_list_v2 获取群发记录列表，查找真实 msgid。
   *
   * 企微坑点：add_msg_template 返回的 msgid 在发送完成后，
   * 直接查 get_groupmsg_task 会返回 41047 invalid group msg id。
   * 必须先从列表接口拉取，列表里的 msgid 才是查询接口认可的。
   *
   * @param originalMsgid add_msg_template 返回的原始 msgid
   * @param senderWecomUserId 发送成员的企微 userid（用来过滤）
   * @param content 发送内容（用来二次匹配）
   * @param createdAt 任务创建时间（用来确定查询时间窗口，避免 10 分钟太短）
   */
  async resolveActualMsgid(
    originalMsgid: string,
    senderWecomUserId?: string,
    content?: string,
    createdAt?: Date,
  ): Promise<string | null> {
    if (this.isMock()) return originalMsgid;
    const token = await this.getContactAccessToken();
    const now = Math.floor(Date.now() / 1000);
    // 用创建时间来定窗口：创建前 1 分钟 → 创建后 24 小时
    // 这样不管用户隔多久才点刷新都能查到（企微接口最多返回 30 天内数据）
    const start = createdAt
      ? Math.floor(createdAt.getTime() / 1000) - 60
      : now - 86400; // fallback：查过去 24h
    let cursor: string | undefined;
    do {
      const url = `${this.baseUrl}/cgi-bin/externalcontact/get_groupmsg_list_v2?access_token=${token}`;
      const body: any = {
        chat_type: 'single',
        start_time: start,
        end_time: now,
        filter_type: 0, // 0=只查企业发表（API 创建的），避免混到个人发表
        limit: 100,
      };
      if (cursor) body.cursor = cursor;
      const list = await this.requestJson<any>(url, 'POST', body);
      const groups = list?.group_msg_list ?? [];
      // 精确 msgid 匹配（最优先）
      for (const g of groups) {
        if (g.msgid === originalMsgid) {
          this.logger.log(
            `[resolveActualMsgid] 精确匹配 msgid=${originalMsgid}`,
          );
          return g.msgid;
        }
      }
      // 再试内容+发送成员精确匹配（双重校验防误匹配）
      if (content) {
        for (const g of groups) {
          const contentMatch = (g.text?.content ?? '') === content.trim();
          const senderMatch =
            !senderWecomUserId ||
            g.sender_list?.some((s: any) => s.userid === senderWecomUserId);
          if (contentMatch && senderMatch) {
            this.logger.log(
              `[resolveActualMsgid] 内容+发送成员匹配 msgid=${g.msgid}（原 msgid=${originalMsgid}）`,
            );
            return g.msgid;
          }
        }
      }
      cursor = list?.next_cursor;
    } while (cursor);
    this.logger.warn(
      `[resolveActualMsgid] 未能在列表中找到 msgid=${originalMsgid} 的群发记录`,
    );
    return null;
  }

  /**
   * 查询群发任务成员发送任务列表（哪些成员收到了群发任务、是否已发送）
   * 注意：返回字段是 task_list（不是 detail），status 数字 0=未发送 2=已发送
   */
  async queryGroupMessageSendStatus(msgid: string, limit = 500) {
    if (this.isMock()) return { task_list: [], next_cursor: undefined };
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/get_groupmsg_task?access_token=${token}`;
    return this.requestJson<any>(url, 'POST', { msgid, limit });
  }

  /**
   * 查询群发任务客户级发送结果（分页）
   * 注意：userid 是**必填**参数！必须传发送成员的企微 userid
   * 返回字段是 send_list（不是 sent_list），status 数字：0=未发送 1=已发送 2=非好友 3=超限
   */
  async queryGroupMessageCustomerResult(
    msgid: string,
    userid: string,
    limit = 500,
    cursor?: string,
  ) {
    if (this.isMock()) return { send_list: [], next_cursor: undefined };
    const token = await this.getContactAccessToken();
    const url = `${this.baseUrl}/cgi-bin/externalcontact/get_groupmsg_send_result?access_token=${token}`;
    const body: any = { msgid, userid, limit };
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
      // 20 秒超时：企微接口偶发不响应时不能让同步永久挂起（undici 默认超时长达数分钟）
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
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
      // token 接口成功响应没有 errcode 但带 access_token
      if (data && typeof data === 'object' && data.access_token) return data as T;
      // 其余情况（网关错误页/空响应/非 JSON）不能当成功返回，否则会被误判成"0 个客户"
      throw new Error(
        `企微接口返回非预期响应 HTTP ${res.status}: ${(text || '').slice(0, 120)}`,
      );
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
