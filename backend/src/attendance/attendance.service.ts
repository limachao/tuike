import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RosterEntryStatus } from '@prisma/client';

/**
 * 听课数据计算引擎
 *
 * 汇总逻辑：
 * 累计有效时长 = 直播有效时长（有效 student 记录汇总，去重） + 回放有效时长
 * 最大课程进度 = MAX(直播推算进度, 回放 locate 最大值)
 *
 * 完成条件（§3）同时满足：
 *   累计有效时长 >= 课程总时长 * completeDurationPercent / 100
 *   最大课程进度 >= 课程总时长 * completeProgressPercent / 100
 *
 * 对于重复播放前 20 分钟两次：累计 40 分钟、最大进度 20 分钟，不完成。
 *
 * 更新到 course_roster 行（totalDurationSec/maxProgressSec/status/lastWatchTime）
 * 并在监控任务中更新缓存计数。
 */
@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  /** 重算单个监控任务下的全部名单条目 */
  async recomputeTask(taskId: number) {
    const task = await this.prisma.courseMonitoringTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { course: true, roster: { where: { isExcluded: false } } },
    });
    let completed = 0;
    let notEntered = 0;
    let incomplete = 0;

    const thresholdDuration =
      (task.course.totalDuration * task.completeDurationPercent) / 100;
    const thresholdProgress =
      (task.course.totalDuration * task.completeProgressPercent) / 100;

    for (const roster of task.roster) {
      const { totalSec, maxProgressSec, lastTime } =
        await this.computeForCustomer(task.courseId, roster.customerId);

      let status: RosterEntryStatus = roster.status;
      if (roster.stopReminder && status === RosterEntryStatus.STOPPED) {
        // keep
      } else {
        if (totalSec === 0 && maxProgressSec === 0) {
          status = RosterEntryStatus.NOT_ENTERED;
          notEntered++;
        } else if (
          totalSec >= thresholdDuration &&
          maxProgressSec >= thresholdProgress
        ) {
          status = RosterEntryStatus.COMPLETED;
          completed++;
        } else {
          status = RosterEntryStatus.INCOMPLETE;
          incomplete++;
        }
      }
      // 自动停止已完成学生的后续提醒
      const shouldStop =
        status === RosterEntryStatus.COMPLETED && !roster.stopReminder;
      await this.prisma.courseRoster.update({
        where: { id: roster.id },
        data: {
          totalDurationSec: totalSec,
          maxProgressSec: maxProgressSec,
          lastWatchTime: lastTime,
          status,
          stopReminder: shouldStop ? true : roster.stopReminder,
          stopReason: shouldStop ? 'completed' : roster.stopReason,
          stoppedAt: shouldStop ? new Date() : roster.stoppedAt,
        },
      });
    }
    // 更新任务统计
    await this.prisma.courseMonitoringTask.update({
      where: { id: taskId },
      data: {
        notEnteredCount: notEntered,
        incompleteCount: incomplete,
        completedCount: completed,
      },
    });
    return {
      taskId,
      thresholdDuration,
      thresholdProgress,
      notEntered,
      incomplete,
      completed,
    };
  }

  /** 对单个客户 + 课程算汇总 */
  async computeForCustomer(courseId: number, customerId: number) {
    // 直播
    const liveAgg = await this.prisma.liveWatchRecord.aggregate({
      _sum: { effectiveDurationSec: true },
      _max: { estimatedMaxProgressSec: true, enterClassTime: true, exitClassTime: true },
      where: { courseId, customerId },
    });
    // 回放
    const replayAgg = await this.prisma.replayWatchRecord.aggregate({
      _sum: { effectiveDurationSec: true },
      _max: { locate: true, enterTime: true, exitTime: true },
      where: { courseId, customerId },
    });
    const totalSec =
      Number(liveAgg._sum.effectiveDurationSec ?? 0) +
      Number(replayAgg._sum.effectiveDurationSec ?? 0);
    const maxProgressSec = Math.max(
      Number(liveAgg._max.estimatedMaxProgressSec ?? 0),
      Number(replayAgg._max.locate ?? 0),
    );
    const allTimes = [
      liveAgg._max.exitClassTime,
      liveAgg._max.enterClassTime,
      replayAgg._max.exitTime,
      replayAgg._max.enterTime,
    ].filter((x): x is Date => !!x);
    const lastTime = allTimes.length
      ? allTimes.reduce((a, b) => (a.getTime() > b.getTime() ? a : b))
      : null;
    return { totalSec, maxProgressSec, lastTime };
  }

  /** 生成某任务的未听课名单：从未进入 + 听课不足 */
  async listNeedReminder(params: {
    taskId: number;
    viewerUserId: number;
    type?: 'not_entered' | 'incomplete' | 'all';
    keyword?: string;
    page?: number;
    pageSize?: number;
    excludeUnmatchedIdentity?: boolean;
  }) {
    const type = params.type ?? 'all';
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 100, 500);

    const where: any = {
      taskId: params.taskId,
      isExcluded: false,
      stopReminder: false,
    };
    const statuses: RosterEntryStatus[] = [];
    if (type === 'all' || type === 'not_entered')
      statuses.push(RosterEntryStatus.NOT_ENTERED);
    if (type === 'all' || type === 'incomplete')
      statuses.push(RosterEntryStatus.INCOMPLETE);
    where.status = { in: statuses };

    const customerWhere: any = {};
    if (params.keyword) {
      customerWhere.OR = [
        { nickname: { contains: params.keyword, mode: 'insensitive' } },
        { externalUserid: { contains: params.keyword } },
      ];
    }
    if (Object.keys(customerWhere).length) where.customer = customerWhere;

    let [list, total] = await Promise.all([
      this.prisma.courseRoster.findMany({
        where,
        include: {
          customer: true,
          task: {
            include: { course: true },
          },
        },
        orderBy: { reminderCount: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.courseRoster.count({ where }),
    ]);

    if (params.excludeUnmatchedIdentity) {
      // 过滤掉身份未确认的客户
      const ids = list.map((r) => r.customerId);
      const okCustomers = await this.prisma.feiceIdentity.groupBy({
        by: ['customerId'],
        where: { customerId: { in: ids }, isConfirmed: true },
      });
      const okSet = new Set(okCustomers.map((x) => x.customerId));
      list = list.filter((r) => okSet.has(r.customerId));
      total = list.length; // 注意：分页总数会变小，但更安全
    }

    return { list, total, page, pageSize };
  }
}
