import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WecomSyncService } from '../wecom/wecom-sync.service';
import { FeiceSyncService } from '../feice/feice-sync.service';
import { IdentityService } from '../identity/identity.service';
import { AttendanceService } from '../attendance/attendance.service';
import { ReminderService } from '../reminder/reminder.service';
import { WecomGroupMessageService } from '../wecom/wecom-group-message.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

/**
 * 定时调度器 + 启动初始化：
 *
 *  - onApplicationBootstrap: 初始化主管账号 + 默认模板
 *  - 每30分钟: 企业微信客户同步（增量）
 *  - 每15分钟: 飞策直播/回放数据同步 + 身份匹配 + 重算听课
 *  - 每10分钟: 刷新未结束群发任务的状态
 *  - 每天08:30: 自动检查"今天到期未听课"名单（首期先不自动创建提醒任务，防止风控）
 *
 * 同步频率支持通过 app_configs 表覆盖。
 */
@Injectable()
export class SyncSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncSchedulerService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly wecom: WecomSyncService,
    private readonly feice: FeiceSyncService,
    private readonly identity: IdentityService,
    private readonly attendance: AttendanceService,
    private readonly groupMsg: WecomGroupMessageService,
    private readonly reminder: ReminderService,
    private readonly auth: AuthService,
  ) {}

  async onApplicationBootstrap() {
    // 1. 初始化主管账号
    const defaultPhone = process.env.DEFAULT_SUPERVISOR_PHONE ?? '13800000000';
    const defaultPwd = process.env.DEFAULT_SUPERVISOR_PASSWORD ?? 'Admin@123456';
    try {
      const created = await this.auth.initSupervisorIfNeeded(defaultPhone, defaultPwd);
      if (created) {
        this.logger.log(
          `[初始化] 已创建默认主管账号：${defaultPhone} / ${defaultPwd}  请及时修改密码！`,
        );
      } else {
        this.logger.log('[初始化] 主管账号已存在，跳过创建。');
      }
    } catch (e) {
      this.logger.warn(`[初始化] 主管账号失败: ${(e as Error).message}`);
    }
    // 2. 默认消息模板
    try {
      await this.reminder.seedDefaultTemplatesIfEmpty();
      this.logger.log('[初始化] 消息模板已就绪。');
    } catch (e) {
      this.logger.warn(`[初始化] 模板初始化失败: ${(e as Error).message}`);
    }
  }

  /** 每 30 分钟同步企业微信客户 */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'sync-wecom' })
  async cronSyncWecom() {
    try {
      await this.wecom.syncUsers();
      await this.wecom.syncAllCustomers();
      this.logger.log('[Cron] 企业微信同步完成');
    } catch (e) {
      this.logger.error(`[Cron] 企业微信同步失败: ${(e as Error).message}`);
    }
  }

  /** 每 15 分钟同步飞策数据（先同步课程，再同步活跃课程的直播回放） */
  @Cron('0 */15 * * * *', { name: 'sync-feice' })
  async cronSyncFeice() {
    try {
      await this.feice.syncCourses();
      const activeCourses = await this.prisma.course.findMany({
        where: { status: { in: ['LIVE', 'ENDED'] } },
        take: 20,
        orderBy: { updatedAt: 'desc' },
      });
      for (const c of activeCourses) {
        try {
          await this.feice.syncLiveRecords(c.id);
          await this.feice.syncReplayRecords(c.id);
          await this.feice.syncInviteRecords(c.id);
        } catch (e) {
          this.logger.warn(
            `课程#${c.id}数据同步失败: ${(e as Error).message}`,
          );
        }
      }
      // 重算身份 + 听课
      await this.identity.runFullMatch();
      const tasks = await this.prisma.courseMonitoringTask.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      for (const t of tasks) {
        try {
          await this.attendance.recomputeTask(t.id);
        } catch (e) {
          this.logger.warn(`任务#${t.id}听课重算失败: ${(e as Error).message}`);
        }
      }
      this.logger.log(`[Cron] 飞策同步完成（处理 ${tasks.length} 个任务）`);
    } catch (e) {
      this.logger.error(`[Cron] 飞策同步失败: ${(e as Error).message}`);
    }
  }

  /** 每 10 分钟刷新未结束群发任务状态 */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'refresh-groupmsg' })
  async cronRefreshGroupMsg() {
    try {
      const pending = await this.prisma.wecomGroupMessageTask.findMany({
        where: {
          status: { in: ['PENDING_CONFIRM', 'EXECUTED', 'PARTIAL_SUCCESS', 'UNKNOWN'] },
        },
        select: { id: true },
      });
      for (const p of pending) {
        try {
          await this.groupMsg.refreshTaskStatus(p.id);
        } catch (e) {
          /* 个体失败不影响整体 */
        }
      }
      if (pending.length) {
        this.logger.log(`[Cron] 刷新群发任务状态 ${pending.length} 个`);
      }
    } catch (e) {
      this.logger.error(`[Cron] 群发任务刷新失败: ${(e as Error).message}`);
    }
  }
}
