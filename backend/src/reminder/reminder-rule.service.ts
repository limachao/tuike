import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * 提醒规则引擎（见 SPEC §11）：
 * - 同一学生同一课程每天最多一次
 * - 同一课程默认最多3次
 * - 21:00 ~ 次日 08:00 禁止自动创建
 * - 已存在结果未知的任务禁止重复创建
 * - 达到最大提醒次数后停止
 *
 * 手动创建只校验前两条，不校验夜间时间（由销售确认时间即可）。
 */
@Injectable()
export class ReminderRuleService {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async canCreateReminder(params: {
    task: any; // CourseMonitoringTask
    customerId: number;
    reminderCount: number;
    maxReminders: number;
  }): Promise<string | null> {
    const dateKey = new Date().toISOString().slice(0, 10);
    // 1. 每天最多一次
    const hit = await this.redis.safeGet(
      `reminder:daily:${params.task.id}:${params.customerId}:${dateKey}`,
    );
    if (hit) {
      return '该学生今日已提醒过，明天再试。';
    }
    // 2. 最多 N 次
    if (params.reminderCount >= params.maxReminders) {
      return '已达到最大提醒次数。';
    }
    // 3. 结果未知的任务中若已包含该学生 → 拒绝
    const unknownTask = await this.prisma.wecomGroupMessageTask.findFirst({
      where: {
        monitoringTaskId: params.task.id,
        status: { in: ['UNKNOWN', 'PENDING_CONFIRM', 'EXECUTED', 'PARTIAL_SUCCESS', 'DRAFT'] },
        recipients: {
          some: { customerId: params.customerId },
        },
      },
    });
    if (unknownTask) {
      return '该学生在未结束的提醒任务中，请勿重复创建。';
    }
    return null;
  }

  /** 夜间拦截（自动调度用） */
  isSilentNightHour(now = new Date()): boolean {
    const h = now.getHours();
    return h >= 21 || h < 8;
  }
}
