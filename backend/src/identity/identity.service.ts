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
    return { matchedIdentities, linkedLive, linkedReplay };
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

  /** 将直播记录按 uid / thirdPartyStudentId / thirdPartyTraceId 回填 customerId */
  async linkLiveRecordsToCustomer() {
    const rows = await this.prisma.liveWatchRecord.findMany({
      where: { customerId: null },
      take: 2000,
    });
    let updated = 0;
    for (const r of rows) {
      const where: any = { customerId: { not: null } };
      const OR: any[] = [];
      if (r.thirdPartyTraceId) OR.push({ thirdPartyTraceId: r.thirdPartyTraceId });
      if (r.thirdPartyStudentId) OR.push({ thirdPartyStudentId: r.thirdPartyStudentId });
      if (r.uid) OR.push({ uid: r.uid });
      if (OR.length === 0) continue;
      where.OR = OR;
      const ident = await this.prisma.feiceIdentity.findFirst({ where, orderBy: { matchLevel: 'asc' } });
      if (ident) {
        await this.prisma.liveWatchRecord.update({
          where: { id: r.id },
          data: { customerId: ident.customerId, feiceIdentityId: ident.id },
        });
        updated++;
      }
    }
    return updated;
  }

  async linkReplayRecordsToCustomer() {
    const rows = await this.prisma.replayWatchRecord.findMany({
      where: { customerId: null },
      take: 20000,
    });
    let updated = 0;
    for (const r of rows) {
      const where: any = { customerId: { not: null } };
      const OR: any[] = [];
      if (r.thirdPartyStudentId) OR.push({ thirdPartyStudentId: r.thirdPartyStudentId });
      if (r.uid) OR.push({ uid: r.uid });
      if (OR.length === 0) continue;
      where.OR = OR;
      const ident = await this.prisma.feiceIdentity.findFirst({ where, orderBy: { matchLevel: 'asc' } });
      if (ident) {
        await this.prisma.replayWatchRecord.update({
          where: { id: r.id },
          data: { customerId: ident.customerId, feiceIdentityId: ident.id },
        });
        updated++;
      }
    }
    return updated;
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
