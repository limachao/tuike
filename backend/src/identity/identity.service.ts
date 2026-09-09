import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * 身份关联引擎
 *
 * 关联链路：
 * external_userid → customer(student_id, thirdPartyTraceId)
 *    → feice_invite_record (thirdPartyTraceId ↔ uid ↔ thirdPartyStudentId)
 *    → live_watch_record / replay_watch_record (uid / thirdPartyStudentId)
 *
 * 匹配优先级（见 SPEC §5.4）：
 * 1. thirdPartyTraceId
 * 2. 内部 student_id
 * 3. thirdPartyStudentId
 * 4. uid
 * 5. 手机号 (mobileHash)
 * 6. unionId
 * 7. 人工关联
 *
 * 本服务提供：
 * - markCustomerIdOnIdentities: 将未匹配的 feiceIdentity 按优先级关联到 customer
 * - linkWatchRecordsToCustomer: 把直播/回放记录的 customerId 字段填上
 * - listUnmatched: 查异常名单
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 运行全量身份关联：
   * 1) 将 feice_identities.customerId=0 的记录，按优先级匹配 customer
   * 2) 把观看记录关联到 customer
   */
  async runFullMatch() {
    const matchedIdentities = await this.matchIdentitiesToCustomers();
    const linkedLive = await this.linkLiveRecordsToCustomer();
    const linkedReplay = await this.linkReplayRecordsToCustomer();
    // 弱匹配兜底：强标识（unionId/手机号/uid 等）全断后，用「微信昵称」关联。
    // 双保险——飞策侧该昵称仅 1 个 uid（同一人）且客户表仅 1 个同名客户才自动关联，
    // 任何一边重名/无昵称/客户不存在一律留空不猜。销售零操作。
    const linkedLiveByName = await this.linkLiveRecordsByNameUnique();
    const linkedReplayByName = await this.linkReplayRecordsByNameUnique();
    if (linkedLiveByName + linkedReplayByName > 0) {
      this.logger.log(
        `[Identity] 昵称唯一弱匹配：直播 ${linkedLiveByName} 条、回放 ${linkedReplayByName} 条`,
      );
    }
    return {
      matchedIdentities,
      linkedLive,
      linkedReplay,
      linkedLiveByName,
      linkedReplayByName,
    };
  }

  /** 按优先级匹配：将 feice_identity 与 customer 关联 */
  async matchIdentitiesToCustomers() {
    // 一次性拉取未匹配 identity（customerId=0）
    const identities = await this.prisma.feiceIdentity.findMany({
      where: { customerId: null },
    });
    let updated = 0;
    for (const id of identities) {
      const customerId = await this.findBestCustomerMatch(id);
      if (customerId) {
        await this.prisma.feiceIdentity.update({
          where: { id: id.id },
          // unionId/手机号/traceId 均为强标识，系统匹配即视为确认
          data: { customerId, isConfirmed: true, matchedAt: new Date() },
        });
        updated++;
      } else {
        // 加入异常名单
        await this.ensureInExceptionList(id);
      }
    }
    return updated;
  }

  private async findBestCustomerMatch(
    id: {
      thirdPartyTraceId?: string | null;
      thirdPartyStudentId?: string | null;
      uid?: string | null;
      mobileHash?: string | null;
      unionId?: string | null;
    },
  ): Promise<number | null> {
    // 1. thirdPartyTraceId（最高优先级，与 customer 直接对应）
    if (id.thirdPartyTraceId) {
      const c = await this.prisma.customer.findFirst({
        where: { thirdPartyTraceId: id.thirdPartyTraceId },
      });
      if (c) return c.id;
    }
    // 2. thirdPartyStudentId 可能等于 studentId（如飞策回填）
    if (id.thirdPartyStudentId) {
      const c = await this.prisma.customer.findFirst({
        where: { studentId: id.thirdPartyStudentId },
      });
      if (c) return c.id;
    }
    // 3. 用 thirdPartyTraceId 从其他已确认的 identity 反查
    if (id.thirdPartyTraceId) {
      const other = await this.prisma.feiceIdentity.findFirst({
        where: { thirdPartyTraceId: id.thirdPartyTraceId, customerId: { not: null } },
      });
      if (other) return other.customerId;
    }
    // 4. uid 相同的其他已确认 identity
    if (id.uid) {
      const other = await this.prisma.feiceIdentity.findFirst({
        where: { uid: id.uid, customerId: { not: null }, isConfirmed: true },
      });
      if (other) return other.customerId;
    }
    // 5. thirdPartyStudentId 反查
    if (id.thirdPartyStudentId) {
      const other = await this.prisma.feiceIdentity.findFirst({
        where: {
          thirdPartyStudentId: id.thirdPartyStudentId,
          customerId: { not: null },
          isConfirmed: true,
        },
      });
      if (other) return other.customerId;
    }
    // 6. mobileHash（飞策记录手机号 sha256 ↔ 企微客户 mobileEncrypted）
    if (id.mobileHash) {
      const c = await this.prisma.customer.findFirst({
        where: { mobileEncrypted: id.mobileHash },
      });
      if (c) return c.id;
    }
    // 7. unionId（微信 unionId ↔ 企微客户 wecom_unionid）
    //    实测飞策观看记录里学员 unionId 基本都有、手机号常为空，这是观看记录匹配的主链路
    if (id.unionId) {
      const c = await this.prisma.customer.findFirst({
        where: { wecomUnionid: id.unionId },
      });
      if (c) return c.id;
    }
    return null;
  }

  private async ensureInExceptionList(feiceId: { id: number }) {
    // 未匹配 identity 没有 customerId，无法直接加入 IdentityMatchException（依赖 customerId 唯一）
    // 这里在 customer 中查不到对应，只能先记日志；异常名单针对 customer 级场景
    this.logger.warn(`FeiceIdentity#${feiceId.id} 无法匹配到任何 customer`);
  }

  /**
   * 将直播记录批量回填 customerId（集合式 SQL）。
   * 旧实现逐条 findFirst 且 take 2000，几十万条积压老记录会把新记录"饿死"；
   * 这里一次性处理全部待关联记录，并增加 unionId 兜底（从 rawData JSON 提取）。
   */
  async linkLiveRecordsToCustomer() {
    const updated = await this.prisma.$executeRaw`
      UPDATE live_watch_records r
      SET "customerId" = fi."customerId",
          "feiceIdentityId" = fi.id
      FROM feice_identities fi
      WHERE r."customerId" IS NULL
        AND fi."customerId" IS NOT NULL
        AND r."userType" = 'student'
        AND (
          (fi.uid IS NOT NULL AND r.uid = fi.uid)
          OR (fi."third_party_student_id" IS NOT NULL AND r."third_party_student_id" = fi."third_party_student_id")
          OR (fi."third_party_trace_id" IS NOT NULL AND r."third_party_trace_id" = fi."third_party_trace_id")
          OR (fi."unionId" IS NOT NULL AND NULLIF((CASE WHEN left(r."rawData", 1) = '{' THEN r."rawData"::jsonb END) ->> 'unionId', '') = fi."unionId")
        )
    `;
    return Number(updated);
  }

  async linkReplayRecordsToCustomer() {
    const updated = await this.prisma.$executeRaw`
      UPDATE replay_watch_records r
      SET "customerId" = fi."customerId",
          "feiceIdentityId" = fi.id
      FROM feice_identities fi
      WHERE r."customerId" IS NULL
        AND fi."customerId" IS NOT NULL
        AND (
          (fi.uid IS NOT NULL AND r.uid = fi.uid)
          OR (fi."third_party_student_id" IS NOT NULL AND r."third_party_student_id" = fi."third_party_student_id")
          OR (fi."unionId" IS NOT NULL AND NULLIF((CASE WHEN left(r."rawData", 1) = '{' THEN r."rawData"::jsonb END) ->> 'unionId', '') = fi."unionId")
        )
    `;
    return Number(updated);
  }

  /**
   * 弱匹配（直播）：强标识全断的记录，用「微信昵称」兜底。
   * 飞策 nickName 与企微客户 nickname 同源（都是微信昵称）。
   * 双保险，必须同时满足才关联：
   *   1) 飞策侧：该昵称（去空格/忽略大小写）在未匹配记录中只对应 1 个 uid（同一个人）；
   *   2) 客户侧：客户表中该昵称只对应 1 个未删除客户。
   * 任一边重名 / 无昵称 / 无 uid → 不更新（customerId 保持 NULL，绝不张冠李戴）。
   * 弱匹配只回填记录 customerId，不写 feiceIdentityId（与强匹配区分，便于回滚）。
   */
  async linkLiveRecordsByNameUnique() {
    const updated = await this.prisma.$executeRaw`
      WITH rec AS (
        SELECT r.id AS rec_id, r.uid,
               LOWER(BTRIM(r."rawData"::jsonb ->> 'nickName')) AS nn
        FROM live_watch_records r
        WHERE r."customerId" IS NULL
          AND r."userType" = 'student'
          AND left(r."rawData", 1) = '{'
          AND NULLIF(BTRIM(r."rawData"::jsonb ->> 'nickName'), '') IS NOT NULL
          AND NULLIF(BTRIM(r.uid), '') IS NOT NULL
      ),
      feice_uniq AS (
        -- 飞策侧：每个昵称仅 1 个 uid
        SELECT nn, MIN(uid) AS uid
        FROM rec
        GROUP BY nn
        HAVING COUNT(DISTINCT uid) = 1
      ),
      cust_uniq AS (
        -- 客户侧：每个昵称仅 1 个未删除客户
        SELECT LOWER(BTRIM(nickname)) AS nn, MIN(id) AS cid
        FROM customers
        WHERE "isDeleted" = false AND NULLIF(BTRIM(nickname), '') IS NOT NULL
        GROUP BY LOWER(BTRIM(nickname))
        HAVING COUNT(DISTINCT id) = 1
      )
      UPDATE live_watch_records r
      SET "customerId" = cu.cid
      FROM rec
      JOIN feice_uniq fu ON fu.nn = rec.nn AND fu.uid = rec.uid
      JOIN cust_uniq cu ON cu.nn = rec.nn
      WHERE r.id = rec.rec_id AND r."customerId" IS NULL
    `;
    return Number(updated);
  }

  /** 弱匹配（回放）：逻辑同直播；回放表无 userType 字段故不加该过滤。 */
  async linkReplayRecordsByNameUnique() {
    const updated = await this.prisma.$executeRaw`
      WITH rec AS (
        SELECT r.id AS rec_id, r.uid,
               LOWER(BTRIM(r."rawData"::jsonb ->> 'nickName')) AS nn
        FROM replay_watch_records r
        WHERE r."customerId" IS NULL
          AND left(r."rawData", 1) = '{'
          AND NULLIF(BTRIM(r."rawData"::jsonb ->> 'nickName'), '') IS NOT NULL
          AND NULLIF(BTRIM(r.uid), '') IS NOT NULL
      ),
      feice_uniq AS (
        SELECT nn, MIN(uid) AS uid
        FROM rec
        GROUP BY nn
        HAVING COUNT(DISTINCT uid) = 1
      ),
      cust_uniq AS (
        SELECT LOWER(BTRIM(nickname)) AS nn, MIN(id) AS cid
        FROM customers
        WHERE "isDeleted" = false AND NULLIF(BTRIM(nickname), '') IS NOT NULL
        GROUP BY LOWER(BTRIM(nickname))
        HAVING COUNT(DISTINCT id) = 1
      )
      UPDATE replay_watch_records r
      SET "customerId" = cu.cid
      FROM rec
      JOIN feice_uniq fu ON fu.nn = rec.nn AND fu.uid = rec.uid
      JOIN cust_uniq cu ON cu.nn = rec.nn
      WHERE r.id = rec.rec_id AND r."customerId" IS NULL
    `;
    return Number(updated);
  }

  /** 异常名单：customer 应听但没有确认过的 feice_identity */
  async listIdentityExceptionCustomers(taskId?: number) {
    // 取 course_roster 中没有确认身份的 customer
    const rosterWhere: any = { isExcluded: false };
    if (taskId) rosterWhere.taskId = taskId;
    const rosters = await this.prisma.courseRoster.findMany({
      where: rosterWhere,
      select: { customerId: true },
    });
    const customerIds = [...new Set(rosters.map((r) => r.customerId))];
    const badIds: number[] = [];
    for (const cid of customerIds) {
      const ok = await this.prisma.feiceIdentity.findFirst({
        where: { customerId: cid, isConfirmed: true },
      });
      if (!ok) badIds.push(cid);
    }
    if (badIds.length === 0) return [];
    return this.prisma.customer.findMany({
      where: { id: { in: badIds } },
      select: {
        id: true,
        studentId: true,
        nickname: true,
        externalUserid: true,
        thirdPartyTraceId: true,
      },
    });
  }

  /** 人工关联：将 uid / thirdPartyStudentId 绑定到指定 customer */
  async manualLink(params: {
    customerId: number;
    uid?: string;
    thirdPartyStudentId?: string;
    operator: number;
  }) {
    const c = await this.prisma.customer.findUniqueOrThrow({
      where: { id: params.customerId },
    });
    // upsert identity
    const data: any = {
      customerId: c.id,
      isConfirmed: true,
      matchLevel: 7,
      matchSource: 'manual',
      matchedAt: new Date(),
      thirdPartyTraceId: c.thirdPartyTraceId ?? undefined,
    };
    if (params.uid) data.uid = params.uid;
    if (params.thirdPartyStudentId) data.thirdPartyStudentId = params.thirdPartyStudentId;

    const existing = await this.prisma.feiceIdentity.findFirst({
      where: {
        OR: [
          params.uid ? { uid: params.uid } : {},
          params.thirdPartyStudentId ? { thirdPartyStudentId: params.thirdPartyStudentId } : {},
        ],
      },
    });
    if (existing) {
      await this.prisma.feiceIdentity.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.feiceIdentity.create({ data });
    }
    await this.prisma.identityMatchException.deleteMany({ where: { customerId: c.id } });
    return { ok: true };
  }
}
