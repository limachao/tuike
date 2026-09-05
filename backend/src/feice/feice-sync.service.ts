import { Injectable, Logger } from '@nestjs/common';
import { FeiceApiService } from './feice-api.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { CourseStatus } from '@prisma/client';
import { IdentityService } from '../identity/identity.service';
import { AttendanceService } from '../attendance/attendance.service';
import * as crypto from 'crypto';

/**
 * 飞策同步：
 * - 课程/直播间
 * - 直播观看记录（按记录去重）
 * - 回放观看记录
 * 同步后写入 sync_log；所有记录带 recordHash 幂等。
 */
@Injectable()
export class FeiceSyncService {
  private readonly logger = new Logger(FeiceSyncService.name);
  constructor(
    private readonly api: FeiceApiService,
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
    private readonly attendance: AttendanceService,
  ) {}

  /** 同步课程/直播间列表（飞策用 offset，没有 page/pageSize） */
  async syncCourses(triggeredBy?: number) {
    const log = await this.prisma.syncLog.create({
      data: { type: 'FEICE_COURSES', triggeredBy, triggeredSource: 'manual' },
    });
    let total = 0;
    try {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const r: any = await this.api.listLiveRooms({ offset });
        for (const item of r.list) {
          await this.upsertCourse(item);
          total++;
        }
        if (r.list.length < 20) hasMore = false;
        else offset += 20;
      }
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { endedAt: new Date(), records: total, success: true },
      });
      return { synced: total };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  /** 同步指定课程的直播观看记录 */
  async syncLiveRecords(courseId: number, triggeredBy?: number) {
    const course = await this.prisma.course.findUniqueOrThrow({ where: { id: courseId } });
    const log = await this.prisma.syncLog.create({
      data: { type: 'FEICE_LIVE_RECORDS', triggeredBy, triggeredSource: 'manual' },
    });
    let total = 0;
    let inserted = 0;
    try {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const r: any = await this.api.listLiveWatchRecords({
          liveRoomId: course.feiceLiveRoomId,
          offset,
        });
        for (const item of r.list) {
          total++;
          const ok = await this.upsertLiveRecord(courseId, item);
          if (ok) inserted++;
        }
        if (r.list.length < 20) hasMore = false;
        else offset += 20;
      }
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: {
          endedAt: new Date(),
          records: total,
          success: true,
          cursor: `inserted=${inserted}`,
        },
      });
      await this.postSyncRefresh(courseId);
      return { total, inserted };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  /** 同步指定课程的回放记录 */
  async syncReplayRecords(courseId: number, triggeredBy?: number) {
    const course = await this.prisma.course.findUniqueOrThrow({ where: { id: courseId } });
    const log = await this.prisma.syncLog.create({
      data: { type: 'FEICE_REPLAY_RECORDS', triggeredBy, triggeredSource: 'manual' },
    });
    let total = 0;
    let inserted = 0;
    try {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const r: any = await this.api.listReplayWatchRecords({
          liveRoomId: course.feiceLiveRoomId,
          offset,
        });
        for (const item of r.list) {
          total++;
          const ok = await this.upsertReplayRecord(courseId, item);
          if (ok) inserted++;
        }
        if (r.list.length < 20) hasMore = false;
        else offset += 20;
      }
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: {
          endedAt: new Date(),
          records: total,
          success: true,
          cursor: `inserted=${inserted}`,
        },
      });
      await this.postSyncRefresh(courseId);
      return { total, inserted };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  /** 同步邀课记录：建立 thirdPartyTraceId -> uid/thirdPartyStudentId */
  async syncInviteRecords(courseId?: number, triggeredBy?: number) {
    const log = await this.prisma.syncLog.create({
      data: { type: 'FEICE_INVITE_RECORDS', triggeredBy, triggeredSource: 'manual' },
    });
    let total = 0;
    try {
      const params: any = {};
      if (courseId) {
        const c = await this.prisma.course.findUnique({ where: { id: courseId } });
        params.liveRoomId = c?.feiceLiveRoomId;
      }
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const r: any = await this.api.listInviteRecords({ ...params, offset });
        for (const item of r.list) {
          total++;
          await this.handleInviteRecord(item);
        }
        if (r.list.length < 20) hasMore = false;
        else offset += 20;
      }
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { endedAt: new Date(), records: total, success: true },
      });
      await this.postSyncRefresh(courseId);
      return { synced: total };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  /**
   * 同步后刷新：身份关联（飞策 uid/unionId/mobile → 企微客户）+ 听课汇总重算。
   * 任何一步失败都不影响同步结果（定时任务 15 分钟后还会兜底跑）。
   */
  private async postSyncRefresh(courseId?: number) {
    try {
      await this.identity.runFullMatch();
      try {
        await this.recomputeListenStats();
      } catch (e) {
        this.logger.warn(`客户听课汇总重算失败: ${(e as Error).message}`);
      }
      const tasks = await this.prisma.courseMonitoringTask.findMany({
        where: { isActive: true, ...(courseId ? { courseId } : {}) },
        select: { id: true },
      });
      for (const t of tasks) {
        try {
          await this.attendance.recomputeTask(t.id);
        } catch (e) {
          this.logger.warn(`任务#${t.id}听课重算失败: ${(e as Error).message}`);
        }
      }
      this.logger.log(`[Feice] 同步后身份关联+重算完成（课程#${courseId ?? '全部'}，任务${tasks.length}个）`);
    } catch (e) {
      this.logger.warn(`同步后身份关联失败: ${(e as Error).message}`);
    }
  }

  /** 重算客户听课时长汇总表（客户信息/快捷群发页直查，避免每次现聚合全表） */
  async recomputeListenStats() {
    await this.prisma.$executeRaw`
      WITH live_agg AS (
        SELECT COALESCE(r."customerId", fi."customerId") AS cid,
               SUM(r."effectiveDurationSec") AS sec
        FROM live_watch_records r
        LEFT JOIN feice_identities fi ON fi.id = r."feiceIdentityId"
        WHERE r."userType" = 'student'
          AND COALESCE(r."customerId", fi."customerId") IS NOT NULL
        GROUP BY 1
      ),
      replay_agg AS (
        SELECT COALESCE(r."customerId", fi."customerId") AS cid,
               SUM(r."effectiveDurationSec") AS sec
        FROM replay_watch_records r
        LEFT JOIN feice_identities fi ON fi.id = r."feiceIdentityId"
        WHERE COALESCE(r."customerId", fi."customerId") IS NOT NULL
        GROUP BY 1
      )
      INSERT INTO customer_listen_stats ("customerId", "liveSec", "replaySec", "updatedAt")
      SELECT c.id, COALESCE(l.sec, 0)::int, COALESCE(p.sec, 0)::int, now()
      FROM customers c
      LEFT JOIN live_agg l ON l.cid = c.id
      LEFT JOIN replay_agg p ON p.cid = c.id
      WHERE COALESCE(l.sec, 0) + COALESCE(p.sec, 0) > 0
      ON CONFLICT ("customerId") DO UPDATE
        SET "liveSec" = EXCLUDED."liveSec",
            "replaySec" = EXCLUDED."replaySec",
            "updatedAt" = now()
    `;
  }

  /** 后端启动时兜底重算一次（部署后首次访问即为汇总数据） */
  async onModuleInit() {
    this.recomputeListenStats()
      .then(() => this.logger.log('[Feice] 启动时客户听课汇总重算完成'))
      .catch((e) => this.logger.warn(`启动时汇总重算失败: ${(e as Error).message}`));
  }

  // ========= 内部方法 =========
  private async upsertCourse(item: any) {
    const feiceLiveRoomId = String(item.live_room_id ?? item.liveRoomId ?? item.id ?? '');
    if (!feiceLiveRoomId) return;
    // 飞策实测字段：liveName / startTime("2026-08-07 19:00:00") / endTime / liveStatus
    const name = String(item.liveName ?? item.name ?? item.title ?? '未命名课程').trim() || '未命名课程';
    const startTime = this.parseFeiceTime(item.startTime ?? item.start_time ?? item.liveStartTime);
    const endTime = this.parseFeiceTime(item.endTime ?? item.end_time ?? item.liveEndTime);
    // 时长：优先用接口字段，否则用 end-start 推算（单位：秒）
    let totalDuration = Number(item.duration ?? item.liveDuration ?? 0);
    if ((!totalDuration || totalDuration <= 0) && startTime && endTime) {
      totalDuration = Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 1000));
    }
    let status: CourseStatus = CourseStatus.NOT_STARTED;
    const now = new Date();
    if (startTime && endTime) {
      if (now < startTime) status = CourseStatus.NOT_STARTED;
      else if (now > endTime) status = CourseStatus.ENDED;
      else status = CourseStatus.LIVE;
    } else {
      // 缺时间信息时，用飞策 liveStatus 兜底（2=已结束）
      if (Number(item.liveStatus) === 2) status = CourseStatus.ENDED;
    }
    const data: any = {
      name,
      coverUrl: item.coverUrl ?? item.cover_url ?? item.cover ?? null,
      description: item.description ?? item.desc ?? null,
      startTime,
      endTime,
      totalDuration,
      status,
      isReplayReady: status === CourseStatus.ENDED || item.replayReady === true || item.hasReplay === true,
      liveEntryUrl: item.liveEntryUrl ?? item.live_entry_url ?? item.liveUrl ?? null,
      replayEntryUrl: item.replayEntryUrl ?? item.replay_entry_url ?? item.replayUrl ?? null,
      lastSyncedAt: new Date(),
    };
    await this.prisma.course.upsert({
      where: { feiceLiveRoomId },
      create: { feiceLiveRoomId, feiceLiveId: item.liveId ?? item.live_id ?? undefined, ...data },
      update: data,
    });
  }

  /** 解析飞策时间字符串 "2026-08-07 19:00:00"（北京时间 UTC+8）为 Date */
  private parseFeiceTime(v: any): Date | null {
    if (!v) return null;
    if (typeof v === 'number') return new Date(v); // 毫秒时间戳
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return new Date(Number(s));
    // 飞策时间是北京时间（无时区后缀），显式按 UTC+8 解析，避免容器 UTC 时区导致差 8 小时
    const iso = s.replace(' ', 'T') + '+08:00';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  private async upsertLiveRecord(courseId: number, item: any): Promise<boolean> {
    const uid = this.blankToNull(item.uid) ?? '';
    const liveId = this.blankToNull(item.live_id ?? item.liveId) ?? '';
    const enter = item.enter_class_time ?? item.enterClassTime;
    const enterStr = enter ? String(enter) : 'x';
    const hashSource = `${uid}|${liveId}|${enterStr}|${item.learningDuration ?? 0}`;
    const recordHash = crypto.createHash('sha1').update(hashSource).digest('hex');
    // 文档（2026-09-05 实读+实测）：userType 为数字，0=学员 1=助教；兼容历史字符串值
    const rawUserType = item.user_type ?? item.userType;
    const utNum = Number(rawUserType);
    const isStudent = isNaN(utNum)
      ? !['teacher', 'assistant', 'host'].includes(String(rawUserType ?? '').toLowerCase())
      : utNum === 0;
    const userType = isStudent ? 'student' : 'assistant';

    try {
      const learningDuration = Number(item.learningDuration ?? 0);
      const effectiveSec = this.normalizeDurationSec(learningDuration);
      const enterClass = this.normalizeTime(enter);
      const exitClass = this.normalizeTime(item.exit_class_time ?? item.exitClassTime);
      // 推算最大进度
      let estimatedProgress = 0;
      if (enterClass && exitClass) {
        estimatedProgress = Math.max(
          0,
          Math.floor((exitClass.getTime() - enterClass.getTime()) / 1000),
        );
      }
      const thirdPartyStudentId = item.third_party_student_id ?? item.thirdPartyStudentId;
      const thirdPartyTraceId = item.third_party_trace_id ?? item.thirdPartyTraceId;
      await this.prisma.liveWatchRecord.create({
        data: {
          courseId,
          uid: uid || null,
          liveId: liveId || null,
          userType,
          learningDuration,
          enterClassTime: enterClass,
          exitClassTime: exitClass,
          effectiveDurationSec: isStudent ? effectiveSec : 0,
          estimatedMaxProgressSec: isStudent ? Math.min(estimatedProgress, effectiveSec) : 0,
          thirdPartyStudentId: thirdPartyStudentId ? String(thirdPartyStudentId) : null,
          thirdPartyTraceId: thirdPartyTraceId ? String(thirdPartyTraceId) : null,
          recordHash,
          rawData: JSON.stringify(item),
        },
      });
      // 观看记录本身也带 uid/unionId/mobile，同样要建身份（不能只依赖邀课记录）
      if (isStudent) await this.ensureIdentityFromRecord(item, 'live_record');
      return isStudent;
    } catch (e: any) {
      // unique 冲突 -> 已存在
      if (String(e?.code) === 'P2002') return false;
      throw e;
    }
  }

  private async upsertReplayRecord(courseId: number, item: any): Promise<boolean> {
    const uid = this.blankToNull(item.uid) ?? '';
    const liveRoomId = this.blankToNull(item.live_room_id ?? item.liveRoomId) ?? '';
    const enter = this.normalizeTime(item.enter_time ?? item.enterTime);
    const exit = this.normalizeTime(item.exit_time ?? item.exitTime);
    // 文档：locate = 本次学习观看最大进度（秒）
    const locate = Number(item.locate ?? 0);
    const hashSource = `${uid}|${liveRoomId}|${enter?.getTime() ?? 0}|${exit?.getTime() ?? 0}|${locate}`;
    const recordHash = crypto.createHash('sha1').update(hashSource).digest('hex');
    const onlineSec = enter && exit
      ? Math.max(0, Math.floor((exit.getTime() - enter.getTime()) / 1000))
      : 0;
    // 有效听课时长：在线时长与观看进度取小，防止挂着不看刷时长；
    // 缺时间但有进度时直接用进度秒数
    const effectiveSec = locate > 0 ? Math.min(onlineSec || locate, locate) : onlineSec;
    const thirdPartyStudentId = item.third_party_student_id ?? item.thirdPartyStudentId;
    try {
      await this.prisma.replayWatchRecord.create({
        data: {
          courseId,
          uid: uid || null,
          liveRoomId: liveRoomId || null,
          locate,
          enterTime: enter,
          exitTime: exit,
          effectiveDurationSec: effectiveSec,
          thirdPartyStudentId: thirdPartyStudentId ? String(thirdPartyStudentId) : null,
          recordHash,
          rawData: JSON.stringify(item),
        },
      });
      await this.ensureIdentityFromRecord(item, 'replay_record');
      return true;
    } catch (e: any) {
      if (String(e?.code) === 'P2002') return false;
      throw e;
    }
  }

  /**
   * 邀课记录处理：thirdPartyTraceId -> uid / thirdPartyStudentId 写入 feice_identities
   * 并找到对应的 customer，建立身份关联。
   */
  private async handleInviteRecord(item: any) {
    const thirdPartyTraceId = this.blankToNull(
      item.third_party_trace_id ?? item.thirdPartyTraceId,
    );
    const uid = this.blankToNull(item.uid);
    const thirdPartyStudentId = this.blankToNull(
      item.third_party_student_id ?? item.thirdPartyStudentId,
    );
    const mobile = this.blankToNull(item.mobile);
    const unionId = this.blankToNull(item.union_id ?? item.unionId);
    if (!thirdPartyTraceId && !uid && !thirdPartyStudentId) return;

    // 找 customer
    const customer = thirdPartyTraceId
      ? await this.prisma.customer.findFirst({
          where: { thirdPartyTraceId: String(thirdPartyTraceId) },
        })
      : null;
    const customerId = customer?.id;

    // 关联到 customer 或暂悬
    const mobileHash = mobile ? crypto.createHash('sha256').update(String(mobile)).digest('hex') : null;

    // 按优先级找或创建 FeiceIdentity
    const identity = await this.prisma.feiceIdentity.findFirst({
      where: {
        OR: [
          thirdPartyTraceId ? { thirdPartyTraceId: String(thirdPartyTraceId) } : {},
          uid ? { uid } : {},
          thirdPartyStudentId ? { thirdPartyStudentId } : {},
        ],
      },
    });
    if (!identity) {
      await this.prisma.feiceIdentity.create({
        data: {
          customerId: customerId ?? null, // null 代表未匹配；后续 IdentityService 会补
          uid,
          thirdPartyStudentId,
          thirdPartyTraceId: thirdPartyTraceId ? String(thirdPartyTraceId) : null,
          mobileHash,
          unionId,
          matchLevel: thirdPartyTraceId ? 1 : thirdPartyStudentId ? 3 : uid ? 4 : mobile ? 5 : 0,
          matchSource: 'invite_record',
          matchedAt: new Date(),
        },
      });
    } else {
      await this.prisma.feiceIdentity.update({
        where: { id: identity.id },
        data: {
          uid: uid ?? identity.uid,
          thirdPartyStudentId: thirdPartyStudentId ?? identity.thirdPartyStudentId,
          thirdPartyTraceId: thirdPartyTraceId ? String(thirdPartyTraceId) : identity.thirdPartyTraceId,
          mobileHash: mobileHash ?? identity.mobileHash,
          unionId: unionId ?? identity.unionId,
        },
      });
    }
    // customerId=0 的，通过 thirdPartyTraceId 回填
    if (customerId) {
      await this.prisma.feiceIdentity.updateMany({
        where: { thirdPartyTraceId: String(thirdPartyTraceId), customerId: null },
        data: { customerId, isConfirmed: true, matchLevel: 1, matchedAt: new Date() },
      });
    }
  }

  /**
   * 从任意飞策记录（直播观看/回放观看）提取身份信息，建立或补全 feice_identity。
   * customerId=0 暂悬，后续由 IdentityService 按 unionId/手机号等匹配到企微客户。
   * 实测（2026-09-05）：学员观看记录 unionId 基本都有、手机号常为空，
   * 所以不能只靠邀课记录建身份——观看记录本身也要建。
   */
  private async ensureIdentityFromRecord(item: any, source: string) {
    const uid = this.blankToNull(item.uid);
    const unionId = this.blankToNull(item.union_id ?? item.unionId);
    const mobile = this.blankToNull(item.mobile);
    const thirdPartyStudentId = this.blankToNull(
      item.third_party_student_id ?? item.thirdPartyStudentId,
    );
    const thirdPartyTraceId = this.blankToNull(
      item.third_party_trace_id ?? item.thirdPartyTraceId,
    );
    if (!uid && !unionId && !mobile && !thirdPartyStudentId && !thirdPartyTraceId) return;

    const mobileHash = mobile
      ? crypto.createHash('sha256').update(String(mobile)).digest('hex')
      : null;

    const OR: any[] = [
      uid ? { uid } : null,
      unionId ? { unionId } : null,
      thirdPartyStudentId ? { thirdPartyStudentId } : null,
      thirdPartyTraceId ? { thirdPartyTraceId } : null,
      mobileHash ? { mobileHash } : null,
    ].filter(Boolean);

    const existing = await this.prisma.feiceIdentity.findFirst({ where: { OR } });
    if (!existing) {
      await this.prisma.feiceIdentity.create({
        data: {
          customerId: null, // null 代表未匹配；IdentityService 会按优先级补
          uid,
          unionId,
          mobileHash,
          thirdPartyStudentId,
          thirdPartyTraceId,
          matchLevel: thirdPartyTraceId ? 1 : thirdPartyStudentId ? 3 : uid ? 4 : mobile ? 5 : 6,
          matchSource: source,
          matchedAt: new Date(),
        },
      });
    } else {
      await this.prisma.feiceIdentity.update({
        where: { id: existing.id },
        data: {
          uid: uid ?? existing.uid,
          unionId: unionId ?? existing.unionId,
          mobileHash: mobileHash ?? existing.mobileHash,
          thirdPartyStudentId: thirdPartyStudentId ?? existing.thirdPartyStudentId,
          thirdPartyTraceId: thirdPartyTraceId ?? existing.thirdPartyTraceId,
        },
      });
    }
  }

  // ====== utils ======
  /**
   * 飞策缺失字段常返回空字符串 ""。?? 只认 null/undefined 不认 ""，
   * 直接用 ?? 合并会把已有的 unionId/手机号等身份字段覆盖成空串，
   * 统一在这里把空白值归一为 null。
   */
  private blankToNull(v: any): string | null {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  }

  private normalizeDurationSec(v: any): number {
    const n = Number(v ?? 0);
    if (n <= 0) return 0;
    // 如果飞策返回毫秒，> 3600*100 就当毫秒处理
    if (n > 3600 * 100) return Math.floor(n / 1000);
    return Math.floor(n);
  }
  private normalizeTime(v: any): Date | null {
    if (!v) return null;
    const s = String(v).trim();
    const n = Number(s);
    if (!isNaN(n) && n > 1e9) {
      return new Date(n >= 1e12 ? n : n * 1000);
    }
    // 飞策时间字符串是北京时间（UTC+8，无时区后缀）；容器内时区为 UTC，
    // 直接 new Date 会慢 8 小时，显式补 +08:00
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) {
      const d = new Date(s.replace(' ', 'T') + '+08:00');
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
}
