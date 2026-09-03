import { Injectable, Logger } from '@nestjs/common';
import { FeiceApiService } from './feice-api.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { CourseStatus } from '@prisma/client';
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
      return { synced: total };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  // ========= 内部方法 =========
  private async upsertCourse(item: any) {
    const feiceLiveRoomId = String(item.live_room_id ?? item.id ?? item.liveRoomId);
    if (!feiceLiveRoomId) return;
    const name = item.name ?? item.title ?? '未命名课程';
    const startTime = item.start_time ? new Date(item.start_time) : null;
    const endTime = item.end_time ? new Date(item.end_time) : null;
    const totalDuration = Number(item.duration ?? 0); // 秒或分钟，由后续修正
    let status: CourseStatus = CourseStatus.NOT_STARTED;
    const now = new Date();
    if (startTime && endTime) {
      if (now < startTime) status = CourseStatus.NOT_STARTED;
      else if (now > endTime) status = CourseStatus.ENDED;
      else status = CourseStatus.LIVE;
    }
    const data: any = {
      name,
      coverUrl: item.cover_url ?? item.cover,
      description: item.description ?? item.desc,
      startTime,
      endTime,
      totalDuration,
      status,
      isReplayReady: item.replay_ready ?? item.hasReplay ?? false,
      liveEntryUrl: item.live_entry_url ?? item.liveUrl,
      replayEntryUrl: item.replay_entry_url ?? item.replayUrl,
      lastSyncedAt: new Date(),
    };
    await this.prisma.course.upsert({
      where: { feiceLiveRoomId },
      create: { feiceLiveRoomId, feiceLiveId: item.live_id ?? undefined, ...data },
      update: data,
    });
  }

  private async upsertLiveRecord(courseId: number, item: any): Promise<boolean> {
    const uid = String(item.uid ?? '');
    const liveId = String(item.live_id ?? item.liveId ?? '');
    const enter = item.enter_class_time ?? item.enterClassTime;
    const enterStr = enter ? String(enter) : 'x';
    const hashSource = `${uid}|${liveId}|${enterStr}|${item.learningDuration ?? 0}`;
    const recordHash = crypto.createHash('sha1').update(hashSource).digest('hex');
    // 过滤讲师/助教
    const userType = String(item.user_type ?? item.userType ?? 'student');
    const isStudent = !['teacher', 'assistant', 'host'].includes(userType.toLowerCase());

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
          uid,
          liveId,
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
      return isStudent;
    } catch (e: any) {
      // unique 冲突 -> 已存在
      if (String(e?.code) === 'P2002') return false;
      throw e;
    }
  }

  private async upsertReplayRecord(courseId: number, item: any): Promise<boolean> {
    const uid = String(item.uid ?? '');
    const liveRoomId = String(item.live_room_id ?? item.liveRoomId ?? '');
    const enter = this.normalizeTime(item.enter_time ?? item.enterTime);
    const exit = this.normalizeTime(item.exit_time ?? item.exitTime);
    const locate = Number(item.locate ?? 0);
    const hashSource = `${uid}|${liveRoomId}|${enter?.getTime() ?? 0}|${exit?.getTime() ?? 0}|${locate}`;
    const recordHash = crypto.createHash('sha1').update(hashSource).digest('hex');
    let effectiveSec = 0;
    if (enter && exit) {
      effectiveSec = Math.max(0, Math.floor((exit.getTime() - enter.getTime()) / 1000));
    }
    const thirdPartyStudentId = item.third_party_student_id ?? item.thirdPartyStudentId;
    try {
      await this.prisma.replayWatchRecord.create({
        data: {
          courseId,
          uid,
          liveRoomId,
          locate,
          enterTime: enter,
          exitTime: exit,
          effectiveDurationSec: effectiveSec,
          thirdPartyStudentId: thirdPartyStudentId ? String(thirdPartyStudentId) : null,
          recordHash,
          rawData: JSON.stringify(item),
        },
      });
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
    const thirdPartyTraceId = item.third_party_trace_id ?? item.thirdPartyTraceId;
    const uid = item.uid ? String(item.uid) : null;
    const thirdPartyStudentId = item.third_party_student_id
      ? String(item.third_party_student_id)
      : null;
    const mobile = item.mobile ?? null;
    const unionId = item.union_id ?? item.unionId ?? null;
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
          customerId: customerId ?? 0, // 0 代表未匹配；后续 IdentityService 会补
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
        where: { thirdPartyTraceId: String(thirdPartyTraceId), customerId: 0 },
        data: { customerId, isConfirmed: true, matchLevel: 1, matchedAt: new Date() },
      });
    }
  }

  // ====== utils ======
  private normalizeDurationSec(v: any): number {
    const n = Number(v ?? 0);
    if (n <= 0) return 0;
    // 如果飞策返回毫秒，> 3600*100 就当毫秒处理
    if (n > 3600 * 100) return Math.floor(n / 1000);
    return Math.floor(n);
  }
  private normalizeTime(v: any): Date | null {
    if (!v) return null;
    const n = Number(v);
    if (!isNaN(n) && n > 1e9) {
      return new Date(n >= 1e12 ? n : n * 1000);
    }
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
}
