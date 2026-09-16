import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { WecomApiService } from './wecom-api.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { RedisService } from '../common/redis/redis.service';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

/**
 * 企业微信同步服务：
 * 1. 同步销售成员（绑定 wecom_userid）
 * 2. 同步每个销售的客户列表 + 详情
 * 3. 生成内部 student_id / third_party_trace_id
 * 4. 处理客户归属关系（主跟进人 + 多对多）
 * 5. 写入同步日志
 */
/** 批量同步的单个客户行（detail 保留用于批量失败时逐条降级） */
interface CustomerSyncRow {
  externalUserid: string;
  nickname: string;
  avatar: string | null;
  gender: number;
  remarkMobiles: string | null;
  mobileEncrypted: string | null;
  wecomUnionid: string | null;
  tags: string | null;
  wecomTags: string | null;
  /** 标签是否已通过 get 接口取完整（含个人标签）。
   *  true=已确认（无标签时 wecomTags 落库为 '[]'）；false=补调失败，关系列保持 NULL */
  tagsComplete: boolean;
  addTime: Date | null;
  detail: any;
}

/**
 * 从企微 follow_info 中提取客户标签（含组名）。
 *
 * 存储格式：[{name, group}]，便于后端列表接口按组过滤。
 * 企微 API 有两种返回形式：
 *   1. follow_info.tags: [{group_id, tag_id, tag_name, type}] —— 直接带 tag_name
 *   2. follow_info.tag_id: string[] —— 只返回 tag_id，需通过标签库接口查 name + group
 */
/**
 * 所有标签组都保留（含「个人标签」和「学员等级」等）：
 * 学员等级组里是「付老师视频号」等渠道来源标签，有业务意义，不能在同步时丢弃。
 */
function extractWecomTagNames(
  followInfo: any,
  tagMap: Map<string, { name: string; group: string }>,
): Array<{ name: string; group: string; tagId?: string }> | null {
  const seen = new Set<string>();
  const out: Array<{ name: string; group: string; tagId?: string }> = [];
  // 路径 1：follow_info.tags 直接带 tag_name + tag_id
  for (const t of Array.isArray(followInfo?.tags) ? followInfo.tags : []) {
    const group = String(t?.group_name ?? '').trim();
    const n = String(t?.tag_name ?? '').trim();
    const tid = t?.tag_id != null ? String(t.tag_id) : undefined;
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push({ name: n, group, ...(tid ? { tagId: tid } : {}) });
    }
  }
  // 路径 2：follow_info.tag_id 需查标签库（带 group 信息）
  for (const tid of Array.isArray(followInfo?.tag_id) ? followInfo.tag_id : []) {
    const info = tagMap.get(String(tid));
    if (info?.name && !seen.has(info.name)) {
      seen.add(info.name);
      out.push({ name: info.name, group: info.group, tagId: String(tid) });
    }
  }
  return out.length ? out : null;
}

@Injectable()
export class WecomSyncService {
  private readonly logger = new Logger(WecomSyncService.name);

  constructor(
    private readonly api: WecomApiService,
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly redis: RedisService,
  ) {}

  /** 同步成员（应用可见范围内开通了客户联系的销售） */
  async syncUsers(triggeredBy?: number) {
    const syncLog = await this.prisma.syncLog.create({
      data: { type: 'WECOM_USERS', triggeredBy, triggeredSource: 'manual' },
    });
    try {
      const followUsers = await this.api.listContactUsers();
      let updated = 0;
      for (const fu of followUsers) {
        // 按手机号匹配需要人工确认；这里按 wecom_userid 绑定。首期主管需先在后台录入销售手机号创建账号，
        // 再将 wecom_userid 绑定。这里提供自动创建（无手机号、isActive=false，待主管确认）
        const exist = await this.prisma.user.findFirst({
          where: { wecomUserId: fu.userid },
        });
        if (!exist) {
          await this.prisma.user.create({
            data: {
              // 先占位，无手机号无法登录。主管需在后台绑定销售手机号
              phone: `unbound_${fu.userid}_${Date.now()}`,
              passwordHash: '*',
              name: fu.name ?? fu.userid,
              role: 'SALES',
              wecomUserId: fu.userid,
              hasCustomerContact: true,
              isActive: false,
            },
          });
        } else if (!exist.hasCustomerContact) {
          await this.users.bindWecomUser(exist.id, fu.userid, true);
        }
        updated++;
      }
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { endedAt: new Date(), records: updated, success: true },
      });
      return { synced: updated };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  /** 同步指定销售名下的客户（批量分页拉取详情，7000+ 客户约几分钟） */
  async syncCustomersForSales(
    salesId: number,
    triggeredBy?: number,
    tagMap?: Map<string, { name: string; group: string }> | null,
  ) {
    // Redis 防重入锁：同一销售 5 分钟内只能触发一次同步
    const lockKey = `sync:customers:${salesId}`;
    const acquired = await this.redis.tryLock(lockKey, 300);
    if (!acquired) {
      throw new BadRequestException(
        '客户同步正在进行中，请 5 分钟后再试（系统自动每 30 分钟同步一次）',
      );
    }
    try {
    // 兜底：如果调用方没传标签库，这里拉一次
    let tm: Map<string, { name: string; group: string }> | null = tagMap ?? null;
    if (!tm) {
      try {
        tm = await this.api.listCustomerTags();
      } catch {
        tm = new Map();
      }
    }
    const sales = await this.users.findById(salesId);
    if (!sales?.wecomUserId) {
      throw new Error('该销售尚未绑定企业微信 userid');
    }
    const syncLog = await this.prisma.syncLog.create({
      data: {
        type: 'WECOM_CUSTOMERS',
        triggeredBy,
        triggeredSource: 'manual',
      },
    });
    let total = 0;
    try {
      let cursor: string | undefined;
      const seenExternalUserids = new Set<string>();
      const rows: CustomerSyncRow[] = [];
      // 企微官方行为：batch/get_by_user 的 follow_info 只会返回企业标签的 tag_id，
      // 个人标签完全不返回。只有 externalcontact/get 单查才返回完整 tags 数组。
      // 所以必须对所有客户补调一次 get，拿到完整的 follow_info.tags（含个人标签）。
      const needRefetch: Array<{ externalUserid: string; item: any }> = [];
      do {
        const { list, nextCursor } = await this.api.getCustomersByUser(
          sales.wecomUserId,
          cursor,
        );
        for (const item of list) {
          const externalUserid = item?.external_contact?.external_userid;
          if (!externalUserid) continue;
          seenExternalUserids.add(externalUserid);
          const row = this.extractCustomerRow(externalUserid, item, tm);
          needRefetch.push({ externalUserid, item });
          rows.push(row);
          total++;
        }
        cursor = nextCursor;
      } while (cursor);

      // 并发补调 get 接口（每批 10 个，避免触发企微限流）
      if (needRefetch.length > 0) {
        this.logger.log(
          `[WeCom同步] 销售#${salesId} 开始补调 get 接口获取完整标签（${needRefetch.length} 个客户）`,
        );
        let refetched = 0;
        /** 补调最终失败的客户（重试 3 次仍失败）：保留其旧标签，绝不用残缺数据覆盖 */
        const refetchFailed = new Set<string>();
        const BATCH = 10;
        const totalBatches = Math.ceil(needRefetch.length / BATCH);
        const t0 = Date.now();
        for (let i = 0; i < needRefetch.length; i += BATCH) {
          const batchIdx = Math.floor(i / BATCH) + 1;
          const batch = needRefetch.slice(i, i + BATCH);
          const results = await Promise.allSettled(
            batch.map(async ({ externalUserid, item }) => {
              const detail = await this.api.getCustomerDetail(externalUserid);
              // get 接口返回的是 follow_user[]（多个跟进人），不是 follow_info
              // 需要找到当前销售对应的跟进人，取其 tags
              const followInfoFromGet = Array.isArray(detail?.follow_user)
                ? detail.follow_user.find((f: any) => f.userid === sales.wecomUserId)
                : null;
              if (followInfoFromGet?.tags?.length) {
                return { externalUserid, item, followInfoFromGet };
              }
              // 即使没 tags，也要把 followInfoFromGet（可能有 tag_id）合并进来
              return { externalUserid, item, followInfoFromGet: null };
            }),
          );
          for (let bi = 0; bi < results.length; bi++) {
            const r = results[bi];
            const externalUserid = batch[bi].externalUserid;
            if (r.status !== 'fulfilled' || !r.value) {
              // 网络/限流/超时：这个客户本轮没拿到完整标签，标记稍后保留旧值
              refetchFailed.add(externalUserid);
              continue;
            }
            const { item, followInfoFromGet } = r.value;
            const idx = rows.findIndex(
              (row) => row.externalUserid === externalUserid,
            );
            if (idx >= 0) {
              // 合并：item.follow_info 的基础字段 + get 返回的 tags/tag_id
              const mergedFollowInfo = {
                ...item?.follow_info,
                ...(followInfoFromGet ?? {}),
                // tags 用 get 返回的（完整含个人标签），覆盖 batch 的空值
                tags: followInfoFromGet?.tags ?? item?.follow_info?.tags,
              };
              rows[idx] = this.extractCustomerRow(externalUserid, {
                ...item,
                follow_info: mergedFollowInfo,
              }, tm);
              // get 成功 = 标签已取完整（即使为空也是企微真实状态）
              rows[idx].tagsComplete = true;
              if (followInfoFromGet?.tags?.length) refetched++;
            }
          }
          // 每 50 批打一条进度
          if (batchIdx % 50 === 0 || batchIdx === totalBatches) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            const speed = (batchIdx * BATCH / (Date.now() - t0) * 1000).toFixed(1);
            this.logger.log(
              `[WeCom同步] 销售#${salesId} 补调进度 ${batchIdx}/${totalBatches} 批 | 已用 ${elapsed}s | 有标签 ${refetched} | 速度 ~${speed}/s`,
            );
          }
        }
        this.logger.log(
          `[WeCom同步] 销售#${salesId} get 补调完成：有标签 ${refetched}/${needRefetch.length}${refetchFailed.size ? `，失败保留旧标签 ${refetchFailed.size} 个` : ''}`,
        );
        // 补调失败的客户：用库里旧标签回填（优先该销售关系上的，其次客户表合集），
        // 避免批量接口返回的不完整标签（缺个人标签）把旧数据冲掉
        if (refetchFailed.size > 0) {
          const failedExts = [...refetchFailed];
          const oldRows: any[] = await this.prisma.$queryRaw`
            SELECT c.external_userid AS ext,
                   r."wecomTags"      AS rel_tags,
                   c.wecom_tags       AS cust_tags
            FROM unnest(${failedExts}::text[]) AS t(ext)
            JOIN customers c ON c.external_userid = t.ext
            LEFT JOIN customer_sales_relations r
              ON r."customerId" = c.id AND r."salesUserId" = ${sales.id}
          `;
          const oldMap = new Map<string, string | null>(
            oldRows.map((o) => [o.ext, o.rel_tags ?? o.cust_tags ?? null]),
          );
          for (const row of rows) {
            if (refetchFailed.has(row.externalUserid)) {
              row.wecomTags = oldMap.get(row.externalUserid) ?? null;
            }
          }
        }
      }
      // 批量落库：每 500 人一批，3 条 SQL 顶过去 ~1500 条逐条查询
      await this.bulkUpsertCustomers(rows, sales.id);
      // 记录本销售本轮出现的全部标签：新标签首次见到即落时间（群发页按此倒序），
      // 已存在的标签只刷新 lastSeenAt，firstSeenAt 永不改变
      await this.recordTagMetas(sales.id, rows);
      // unionid 到手率观测：接口不返回 unionid（未绑微信开发者ID/主体不一致）时恒为 0，
      // 用于快速定位听课记录匹配不到学员的问题
      const withUnionid = rows.reduce((n, r) => n + (r.wecomUnionid ? 1 : 0), 0);
      this.logger.log(
        `[WeCom同步] 销售#${salesId}(${sales.wecomUserId}) 拉取 ${total} 个客户，带 unionid 的 ${withUnionid} 个`,
      );
      // 全量分页成功后，清理本次未返回的归属关系：
      // 客户已删除该销售/销售删除客户/离职继承后，企微接口不再返回，
      // 旧关系必须失效，否则客户会一直挂在已不跟进的销售名下。
      await this.pruneStaleRelations(sales.id, seenExternalUserids);
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          endedAt: new Date(),
          records: total,
          success: true,
          cursor: `unionid=${withUnionid}/${total}`,
        },
      });
      return { salesId, synced: total };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
    } finally {
      // 无论成功还是失败都释放锁（兜底：TPL 300s 超时也会自动释放）
      await this.redis.delLock(lockKey);
    }
  }

  /**
   * 记录销售名下本轮同步出现过的标签名：
   * - 首次出现的标签 INSERT（firstSeenAt=现在），用于群发页"新标签排最前"
   * - 已存在的标签只更新 lastSeenAt，firstSeenAt 保持不变
   * 企微不提供标签创建时间，这是该时间最接近真实的近似值。
   */
  private async recordTagMetas(salesId: number, rows: CustomerSyncRow[]) {
    const names = new Set<string>();
    for (const row of rows) {
      if (!row.wecomTags) continue;
      let arr: any;
      try {
        arr = JSON.parse(row.wecomTags);
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        const n = typeof t === 'string' ? t.trim() : String(t?.name ?? '').trim();
        if (n) names.add(n);
      }
    }
    if (names.size === 0) return;
    const now = new Date();
    // skipDuplicates：已存在的标签不覆盖 firstSeenAt；再统一刷 lastSeenAt
    await this.prisma.salesTagMeta.createMany({
      data: [...names].map((name) => ({ salesUserId: salesId, name })),
      skipDuplicates: true,
    });
    await this.prisma.salesTagMeta.updateMany({
      where: { salesUserId: salesId, name: { in: [...names] } },
      data: { lastSeenAt: now },
    });
  }

  /** 同步全部销售名下客户 */
  async syncAllCustomers(triggeredBy?: number) {
    // 先拉一次标签库，后续按销售同步时复用，避免 N 次远程调用
    let tagMap: Map<string, { name: string; group: string }> | null = null;
    try {
      tagMap = await this.api.listCustomerTags();
      this.logger.log(`企微标签库已加载 ${tagMap.size} 个标签`);
    } catch (e) {
      this.logger.warn(`拉取企微标签库失败（标签名将无法解析）: ${(e as Error).message}`);
    }
    const salesList = await this.users.listActiveSales();
    const result: any = {};
    for (const s of salesList) {
      if (!s.wecomUserId) continue;
      const r = await this.syncCustomersForSales(s.id, triggeredBy, tagMap);
      result[s.id] = r;
    }
    return result;
  }

  /**
   * 写入/更新客户。detail 可直接传入批量接口返回的单条数据：
   * batch/get_by_user 条目为 { external_contact, follow_info }
   * externalcontact/get 返回为 { external_contact, follow_user: [] }
   * 不传 detail 时回退到逐个查详情（兼容旧调用）
   */
  private async upsertCustomer(
    externalUserid: string,
    salesId: number,
    detail?: any,
    tagMap?: Map<string, { name: string; group: string }>,
    /** 已由批量提取阶段算好的标签（带 tagMap），优先于用 detail 重新解析 */
    explicitWecomTags?: string | null,
    /** 标签是否已取完整；false=补调失败保留 NULL，undefined 视为完整（旧 get 调用方） */
    tagsComplete?: boolean,
  ) {
    // 查详情（Mock 模式或未传入时可能为空）
    if (!detail) {
      try {
        detail = await this.api.getCustomerDetail(externalUserid);
      } catch (e) {
        detail = null;
      }
    }
    const contact = detail?.external_contact ?? {};
    // 两种返回结构兼容：follow_info（批量）或 follow_user[]（单个）
    const followInfo =
      detail?.follow_info ??
      (Array.isArray(detail?.follow_user)
        ? detail.follow_user.find((f: any) => f.userid)
        : null);

    const nickname = contact.name ?? '未命名客户';
    const avatar = contact.avatar ?? null;
    const gender = contact.gender ?? 0;
    const tags = JSON.stringify(contact.external_profile?.external_attr ?? []);
    const wecomTagNames = extractWecomTagNames(followInfo, tagMap ?? new Map());
    // explicitWecomTags 可能显式为 null（提取阶段确认无标签），只在 undefined 时用本地解析值
    const wecomTags = explicitWecomTags !== undefined
      ? explicitWecomTags
      : (wecomTagNames ? JSON.stringify(wecomTagNames) : null);
    const remarkMobiles = followInfo?.remark_mobiles?.join(',') ?? null;
    // unionid：企微后台绑定微信开发者ID后 externalcontact/get 才会返回。
    // 注意企微对无 unionid 的客户可能返回空字符串 ""，而 wecom_unionid 有唯一约束，
    // 多个 "" 会触发唯一冲突导致整条批量 SQL 失败，这里统一归一为 null。
    const wecomUnionid = contact.unionid ? contact.unionid : null;
    // 脱敏存储手机号（SHA256 便于匹配飞策 mobile，不可逆）
    const mobileEncrypted = remarkMobiles
      ? crypto.createHash('sha256').update(remarkMobiles.split(',')[0]).digest('hex')
      : null;
    // 添加时间：企微 follow_info 标准字段是 createtime（Unix 秒），
    // 不存在 add_time 字段（历史 bug：取不到值时兜底 new Date()，导致所有
    // 客户的加入时间都变成同步当天）。取不到时保持 null，不伪造数据。
    const followTimeRaw = followInfo?.createtime ?? followInfo?.add_time;
    const addTime = followTimeRaw ? new Date(Number(followTimeRaw) * 1000) : null;

    // upsert 客户
    let customer = await this.prisma.customer.findUnique({
      where: { externalUserid },
    });
    if (!customer) {
      const studentId = `stu_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      const thirdPartyTraceId = `tpt_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
      customer = await this.prisma.customer.create({
        data: {
          externalUserid,
          nickname,
          avatar,
          gender,
          mobileEncrypted,
          remarkMobiles,
          wecomUnionid,
          tags,
          ownerUserId: salesId,
          studentId,
          thirdPartyTraceId,
          firstAddTime: addTime,
          lastSyncedAt: new Date(),
        },
      });
    } else {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          nickname,
          avatar,
          gender,
          remarkMobiles,
          mobileEncrypted: mobileEncrypted ?? customer.mobileEncrypted,
          wecomUnionid: wecomUnionid ?? undefined,
          tags,
          isDeleted: false, // 接口能返回说明好友关系仍在/已恢复
          lastSyncedAt: new Date(),
        },
      });
    }
    // 归属关系（多对多）：标签按销售隔离
    // 完整同步但无标签 -> '[]'；补调失败(tagsComplete=false) -> NULL，合集重建时沿用旧值
    const relationTags = tagsComplete === false ? wecomTags : (wecomTags ?? '[]');
    await this.prisma.customerSalesRelation.upsert({
      where: {
        customerId_salesUserId: { customerId: customer.id, salesUserId: salesId },
      },
      create: {
        customerId: customer.id,
        salesUserId: salesId,
        addTime,
        isPrimary: customer.ownerUserId === salesId,
        wecomTags: relationTags,
      },
      update: { status: 'active', addTime: addTime ?? undefined, wecomTags: relationTags },
    });
    // 该客户标签合集随关系标签更新（客户资料页展示合集）
    await this.rebuildCustomerTags([customer.id]);
    return customer;
  }

  // ========= 批量同步（性能：万级客户从 ~6 万条 SQL 降到 ~120 条） =========

  /** 从企微批量接口的单条返回中提取客户字段 */
  private extractCustomerRow(
    externalUserid: string,
    detail: any,
    tagMap: Map<string, { name: string; group: string }> = new Map(),
  ) {
    const contact = detail?.external_contact ?? {};
    const followInfo =
      detail?.follow_info ??
      (Array.isArray(detail?.follow_user)
        ? detail.follow_user.find((f: any) => f.userid)
        : null);
    const remarkMobiles: string | null = followInfo?.remark_mobiles?.length
      ? followInfo.remark_mobiles.join(',')
      : null;
    const followTimeRaw = followInfo?.createtime ?? followInfo?.add_time;
    return {
      externalUserid,
      nickname: (contact.name ?? '未命名客户').trim() || '未命名客户',
      avatar: contact.avatar ?? null,
      gender: Number(contact.gender ?? 0),
      remarkMobiles,
      mobileEncrypted: remarkMobiles
        ? crypto.createHash('sha256').update(remarkMobiles.split(',')[0]).digest('hex')
        : null,
      // 空字符串归一为 null（wecom_unionid 有唯一约束，多个 '' 会冲突）
      wecomUnionid: contact.unionid ? contact.unionid : null,
      tags: JSON.stringify(contact.external_profile?.external_attr ?? []),
      // 企微客户标签名（follow_info.tag_id / follow_info.tags）
      wecomTags: (() => {
        const names = extractWecomTagNames(followInfo, tagMap);
        return names ? JSON.stringify(names) : null;
      })(),
      // 批量接口只返回企业标签，个人标签需补调 get 才算完整
      tagsComplete: false,
      addTime: followTimeRaw ? new Date(Number(followTimeRaw) * 1000) : null,
      detail,
    };
  }

  /** 分块批量 upsert 客户 + 归属关系；任一分块失败降级为逐条写入 */
  private async bulkUpsertCustomers(rows: CustomerSyncRow[], salesId: number) {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        const studentIds = chunk.map(() => `stu_${uuidv4().replace(/-/g, '').slice(0, 16)}`);
        const traceIds = chunk.map(() => `tpt_${uuidv4().replace(/-/g, '').slice(0, 24)}`);
        await this.prisma.$executeRaw`
          INSERT INTO customers (
            external_userid, nickname, avatar, gender, "mobileEncrypted", "remarkMobiles",
            wecom_unionid, tags, wecom_tags, owner_user_id, student_id, third_party_trace_id,
            "firstAddTime", "lastSyncedAt", "updatedAt", "isDeleted"
          )
          SELECT ext, nick, av, g, mob, rm, NULLIF(uni, '') AS uni, tg, wtg, owner, sid, tid, fat, now(), now(), false
          FROM unnest(
            ${chunk.map((r) => r.externalUserid)}::text[],
            ${chunk.map((r) => r.nickname)}::text[],
            ${chunk.map((r) => r.avatar)}::text[],
            ${chunk.map((r) => r.gender)}::int[],
            ${chunk.map((r) => r.mobileEncrypted)}::text[],
            ${chunk.map((r) => r.remarkMobiles)}::text[],
            ${chunk.map((r) => r.wecomUnionid)}::text[],
            ${chunk.map((r) => r.tags)}::text[],
            ${chunk.map((r) => r.wecomTags)}::text[],
            ${chunk.map(() => salesId)}::int[],
            ${studentIds}::text[],
            ${traceIds}::text[],
            ${chunk.map((r) => r.addTime)}::timestamptz[]
          ) AS t(ext, nick, av, g, mob, rm, uni, tg, wtg, owner, sid, tid, fat)
          ON CONFLICT (external_userid) DO UPDATE SET
            nickname = EXCLUDED.nickname,
            avatar = EXCLUDED.avatar,
            gender = EXCLUDED.gender,
            "remarkMobiles" = EXCLUDED."remarkMobiles",
            "mobileEncrypted" = COALESCE(EXCLUDED."mobileEncrypted", customers."mobileEncrypted"),
            wecom_unionid = COALESCE(EXCLUDED.wecom_unionid, customers.wecom_unionid),
            tags = EXCLUDED.tags,
            -- wecom_tags 不在此更新：它是"所有销售标签合集"，
            -- 由关系写入后统一 rebuildCustomerTags() 汇总，防止后同步销售覆盖前人标签
            "isDeleted" = false,
            "lastSyncedAt" = now(),
            "updatedAt" = now()
        `;
        const extList = chunk.map((r) => r.externalUserid);
        const idRows: any[] = await this.prisma.$queryRaw`
          SELECT id, external_userid, owner_user_id FROM customers
          WHERE external_userid = ANY(${extList}::text[])
        `;
        const idMap = new Map<string, { id: number; owner: number }>(
          idRows.map((r) => [r.external_userid, { id: Number(r.id), owner: Number(r.owner_user_id) }]),
        );
        const relRows = chunk
          .map((r) => ({
            cid: idMap.get(r.externalUserid)?.id,
            isPrimary: idMap.get(r.externalUserid)?.owner === salesId,
            addTime: r.addTime,
            // 已取完整：无标签写 '[]'（明确状态）；补调失败：写 null（沿用旧合集兜底）
            wecomTags: r.tagsComplete ? (r.wecomTags ?? '[]') : r.wecomTags,
          }))
          .filter((r) => r.cid);
        await this.prisma.$executeRaw`
          INSERT INTO customer_sales_relations ("customerId", "salesUserId", "addTime", "isPrimary", status, "wecomTags")
          SELECT cid, ${salesId}, fat, isp, 'active', wtg
          FROM unnest(
            ${relRows.map((r) => r.cid!)}::int[],
            ${relRows.map((r) => r.addTime)}::timestamptz[],
            ${relRows.map((r) => r.isPrimary)}::boolean[],
            ${relRows.map((r) => r.wecomTags)}::text[]
          ) AS t(cid, fat, isp, wtg)
          ON CONFLICT ("customerId", "salesUserId") DO UPDATE SET
            status = 'active',
            "wecomTags" = EXCLUDED."wecomTags",
            "addTime" = COALESCE(
              LEAST(customer_sales_relations."addTime", EXCLUDED."addTime"),
              customer_sales_relations."addTime", EXCLUDED."addTime")
        `;
        // 关系标签已按销售隔离落库，重建这批客户的"全销售标签合集"
        await this.rebuildCustomerTags(relRows.map((r) => r.cid!));
      } catch (e) {
        // 打印完整错误（含 Prisma/Postgres 原因），否则只看到空信息无法排查
        this.logger.error(
          `批量同步分块失败（销售#${salesId}，第 ${Math.floor(i / CHUNK) + 1} 块，${chunk.length} 人），降级为逐条写入`,
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        const fallbackIds: number[] = [];
        for (const r of chunk) {
          try {
            const c = await this.upsertCustomer(
              r.externalUserid, salesId, r.detail, undefined, r.wecomTags, r.tagsComplete,
            );
            fallbackIds.push(c.id);
          } catch (e2) {
            this.logger.warn(
              `客户 ${r.externalUserid} 同步失败: ${(e2 as Error).message}`,
            );
          }
        }
        // 逐条路径里已 rebuild，批量再兜底一次（成功/失败混合时保证合集正确）
        if (fallbackIds.length > 0) await this.rebuildCustomerTags(fallbackIds);
      }
    }
  }

  /**
   * 按所有 active 销售关系上的 wecomTags 重建客户表 wecom_tags 合集。
   * 同名标签跨销售只保留一个；无任何标签 -> NULL。
   * 过渡兼容：若该客户仍有 active 关系的 wecomTags 为 NULL（升级后尚未同步到），
   * 把 customers 表旧合集也并入，保证升级期间一个销售都没重刷完也不丢标签。
   */
  private async rebuildCustomerTags(customerIds: number[]) {
    if (customerIds.length === 0) return;
    const ids = [...new Set(customerIds)];
    await this.prisma.$executeRaw`
      UPDATE customers c
      SET wecom_tags = NULLIF(agg.tags::text, '[]'),
          "updatedAt" = now()
      FROM (
        SELECT t.cid AS customer_id, (
          SELECT COALESCE(jsonb_agg(e.tag), '[]'::jsonb)
          FROM (
            SELECT DISTINCT ON (z.tag->>'name') z.tag
            FROM (
              -- 各销售关系上的新标签
              SELECT x.tag
              FROM customer_sales_relations rr
              CROSS JOIN LATERAL jsonb_array_elements(
                COALESCE(rr."wecomTags"::jsonb, '[]'::jsonb)
              ) AS x(tag)
              WHERE rr."customerId" = t.cid AND rr.status = 'active'
              UNION ALL
              -- 旧合集兜底：仅当还存在未按新方案同步(NULL)的 active 关系
              SELECT y.tag
              FROM customers oldc
              CROSS JOIN LATERAL jsonb_array_elements(
                COALESCE(oldc.wecom_tags::jsonb, '[]'::jsonb)
              ) AS y(tag)
              WHERE oldc.id = t.cid
                AND EXISTS (
                  SELECT 1 FROM customer_sales_relations rr2
                  WHERE rr2."customerId" = t.cid
                    AND rr2.status = 'active'
                    AND rr2."wecomTags" IS NULL
                )
            ) AS z(tag)
            ORDER BY z.tag->>'name'
          ) AS e(tag)
        ) AS tags
        FROM unnest(${ids}::int[]) AS t(cid)
      ) AS agg
      WHERE c.id = agg.customer_id
    `;
  }

  /**
   * 全量同步后清理失效归属：
   * 1. 该销售名下、本次接口未返回的客户关系 -> status=deleted
   * 2. 受影响客户若无任何 active 关系 -> 标记 isDeleted
   * 3. 若失效的是主归属销售(ownerUserId)，转交给仍有效的、最早添加的销售
   */
  private async pruneStaleRelations(salesId: number, seenExternalUserids: Set<string>) {
    const staleRelations = await this.prisma.customerSalesRelation.findMany({
      where: {
        salesUserId: salesId,
        status: 'active',
        customer: { externalUserid: { notIn: [...seenExternalUserids] } },
      },
      select: { id: true, customerId: true },
    });
    if (staleRelations.length === 0) return;
    const staleIds = staleRelations.map((r) => r.id);
    const affectedCustomerIds = [...new Set(staleRelations.map((r) => r.customerId))];

    await this.prisma.customerSalesRelation.updateMany({
      where: { id: { in: staleIds } },
      data: { status: 'deleted', isPrimary: false },
    });

    for (const customerId of affectedCustomerIds) {
      const activeRelations = await this.prisma.customerSalesRelation.findMany({
        where: { customerId, status: 'active' },
        orderBy: [{ addTime: 'asc' }, { id: 'asc' }],
      });
      if (activeRelations.length === 0) {
        // 所有销售都已无该客户好友关系
        await this.prisma.customer.update({
          where: { id: customerId },
          data: { isDeleted: true, unfollowReason: '同步确认：无任何有效跟进销售' },
        });
        continue;
      }
      // 主归属保持/转交给最早添加的有效销售
      const primary = activeRelations[0];
      await this.prisma.customerSalesRelation.updateMany({
        where: { customerId },
        data: { isPrimary: false },
      });
      await this.prisma.customerSalesRelation.update({
        where: { id: primary.id },
        data: { isPrimary: true },
      });
      await this.prisma.customer.update({
        where: { id: customerId },
        data: { ownerUserId: primary.salesUserId, isDeleted: false },
      });
    }
    // 关系删除/转交后，受影响客户的标签合集需要重建
    await this.rebuildCustomerTags(affectedCustomerIds);
    this.logger.log(
      `销售#${salesId} 同步清理失效关系 ${staleRelations.length} 条，涉及客户 ${affectedCustomerIds.length} 位`,
    );
  }
}
