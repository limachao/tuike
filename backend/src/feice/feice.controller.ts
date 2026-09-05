import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { FeiceSyncService } from './feice-sync.service';
import { FeiceInviteService } from './feice-invite.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller('feice')
@UseGuards(JwtAuthGuard)
export class FeiceController {
  constructor(
    private readonly sync: FeiceSyncService,
    private readonly invite: FeiceInviteService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('sync/courses')
  syncCourses(@CurrentUser() u: JwtUserPayload) {
    return this.sync.syncCourses(u.sub);
  }

  @Post('sync/course/:id/live-records')
  syncLiveRecords(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.sync.syncLiveRecords(Number(id), u.sub);
  }

  @Post('sync/course/:id/replay-records')
  syncReplayRecords(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.sync.syncReplayRecords(Number(id), u.sub);
  }

  @Post('sync/invite-records')
  syncInviteRecords(
    @Query('courseId') courseId: string | undefined,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.sync.syncInviteRecords(
      courseId ? Number(courseId) : undefined,
      u.sub,
    );
  }

  @Get('courses')
  listCourses(
    @Query('keyword') keyword: string | undefined,
    @CurrentUser() u: JwtUserPayload,
  ) {
    const where: any = {};
    if (keyword) {
      where.name = { contains: keyword, mode: 'insensitive' };
    }
    return this.prisma.course.findMany({
      where,
      orderBy: { startTime: 'desc' },
      take: 100,
    });
  }

  /**
   * 飞策原始听课记录（按微信身份聚合）：
   * 昵称/unionId 直接取自飞策 rawData，未匹配企微客户也能查看。
   * 微信开放平台认证通过、身份匹配完成后，customerNickname 会自动填上。
   */
  @Get('courses/:id/watch-records')
  async listWatchRecords(
    @Param('id') id: string,
    @Query('keyword') keyword: string | undefined,
  ) {
    const courseId = Number(id);
    const kw = keyword?.trim() || null;
    const rows: any[] = await this.prisma.$queryRaw`
      WITH recs AS (
        SELECT 'live' AS kind, r.uid, r."customerId" AS customer_id,
               r."effectiveDurationSec" AS dur, r."estimatedMaxProgressSec" AS prog,
               r."enterClassTime" AS watched_at,
               NULLIF(r."rawData"::jsonb->>'unionId','') AS union_id,
               NULLIF(r."rawData"::jsonb->>'nickName','') AS nick_name
        FROM live_watch_records r
        WHERE r."courseId" = ${courseId} AND r."userType" = 'student'
        UNION ALL
        SELECT 'replay', r.uid, r."customerId",
               r."effectiveDurationSec", r.locate, r."enterTime",
               NULLIF(r."rawData"::jsonb->>'unionId',''),
               NULLIF(r."rawData"::jsonb->>'nickName','')
        FROM replay_watch_records r
        WHERE r."courseId" = ${courseId}
      ),
      agg AS (
        SELECT
          COALESCE(MAX(union_id), MAX(uid)) AS person_key,
          MAX(nick_name) AS nick_name,
          COUNT(*) FILTER (WHERE kind='live')   AS live_sessions,
          COUNT(*) FILTER (WHERE kind='replay') AS replay_sessions,
          COALESCE(SUM(dur) FILTER (WHERE kind='live'),0)   AS live_duration_sec,
          COALESCE(SUM(dur) FILTER (WHERE kind='replay'),0) AS replay_duration_sec,
          COALESCE(MAX(prog),0) AS max_progress_sec,
          MAX(watched_at) AS last_watch_at,
          MAX(customer_id) AS customer_id
        FROM recs
        GROUP BY COALESCE(union_id, uid)
      )
      SELECT agg.*, c.nickname AS customer_nickname
      FROM agg
      LEFT JOIN customers c ON c.id = agg.customer_id
      WHERE (${kw}::text IS NULL
             OR agg.nick_name ILIKE '%'||${kw}||'%'
             OR c.nickname ILIKE '%'||${kw}||'%')
      ORDER BY (agg.live_duration_sec + agg.replay_duration_sec) DESC
      LIMIT 500
    `;
    return rows.map((r) => ({
      personKey: r.person_key,
      nickName: r.nick_name ?? '（微信未授权昵称）',
      liveSessions: Number(r.live_sessions),
      replaySessions: Number(r.replay_sessions),
      liveDurationSec: Number(r.live_duration_sec),
      replayDurationSec: Number(r.replay_duration_sec),
      maxProgressSec: Number(r.max_progress_sec),
      lastWatchAt: r.last_watch_at,
      customerId: r.customer_id ? Number(r.customer_id) : null,
      customerNickname: r.customer_nickname ?? null,
    }));
  }

  /** 内部员工观看课程/回放：生成飞策入口链接并新窗口打开 */
  @Get('courses/:id/play-link')
  async getPlayLink(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    const course = await this.prisma.course.findUniqueOrThrow({
      where: { id: Number(id) },
    });
    const r = await this.invite.buildInternalPlayUrl({
      liveRoomId: course.feiceLiveRoomId,
      userId: u.sub,
    });
    return { url: r.url };
  }
}
