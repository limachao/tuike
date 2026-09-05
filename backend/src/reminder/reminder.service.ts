import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  GroupMessageStatus,
  MessageTemplateType,
  RosterEntryStatus,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis/redis.service';
import { AttendanceService } from '../attendance/attendance.service';
import { WecomGroupMessageService } from '../wecom/wecom-group-message.service';
import { AuditLogService } from '../audit/audit-log.service';
import { v4 as uuidv4 } from 'uuid';
import { ReminderRuleService } from './reminder-rule.service';

/**
 * 群发提醒任务创建：
 *
 * 0. 读取未听课名单 → 调用提醒规则引擎（频率/次数/夜间/重复拦截）
 * 1. 确定模板类型（NEVER_ENTERED vs INCOMPLETE）
 * 2. 组装最终文案（可被销售覆盖修改）
 * 3. 创建任务草稿
 * 4. 保存 msgid
 * 5. 调用企业微信
 *
 * 全程写审计日志。
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly rules: ReminderRuleService,
    private readonly attendance: AttendanceService,
    private readonly wecomGroup: WecomGroupMessageService,
    private readonly audit: AuditLogService,
  ) {}

  /** 预览文案 + 名单统计（创建前调用） */
  async preview(params: {
    taskId: number;
    operatorId: number;
    templateType: MessageTemplateType;
    customContent?: string;
    entryType?: 'live' | 'replay';
    rosterIds?: number[]; // 勾选的名单；空=整份未听课名单
  }) {
    // 1. 再次重算确保名单新鲜
    await this.attendance.recomputeTask(params.taskId);
    // 2. 筛选未听课且未停止提醒 + 已匹配身份
    let { list } = await this.attendance.listNeedReminder({
      taskId: params.taskId,
      viewerUserId: params.operatorId,
      type:
        params.templateType === MessageTemplateType.NEVER_ENTERED
          ? 'not_entered'
          : params.templateType === MessageTemplateType.INCOMPLETE
            ? 'incomplete'
            : 'all',
      excludeUnmatchedIdentity: true,
      pageSize: 5000,
    });
    if (params.rosterIds && params.rosterIds.length) {
      const set = new Set(params.rosterIds);
      list = list.filter((r) => set.has(r.id));
    }
    // 3. 模板
    const tmpl = await this.getDefaultTemplate(params.templateType);
    const finalContent = params.customContent?.trim() || tmpl?.content || '';
    // 4. 生成统一链接：中转页 /course/{course.feiceLiveRoomId}
    const baseUrl =
      this.config.get<string>('TRANSFER_PAGE_BASE_URL') || 'http://localhost:5173';
    const course = list[0]?.task?.course;
    const finalUrl = course
      ? `${baseUrl}/course/${course.feiceLiveRoomId}`
      : `${baseUrl}/course`;

    return {
      rosterTotal: list.length,
      templateUsed: tmpl,
      finalContent,
      finalUrl,
      entryType: params.entryType ?? (course?.status === 'ENDED' ? 'replay' : 'live'),
      recipientsPreview: list.slice(0, 20),
    };
  }

  /**
   * 创建提醒任务 + 提交到企业微信
   */
  async createAndSubmit(params: {
    taskId: number;
    operatorId: number;
    templateType: MessageTemplateType;
    customContent?: string;
    entryType?: 'live' | 'replay';
    rosterIds?: number[];
  }) {
    // 0. 前置检查
    const task = await this.prisma.courseMonitoringTask.findUniqueOrThrow({
      where: { id: params.taskId },
      include: { course: true },
    });
    if (task.createdBySalesId !== params.operatorId) {
      throw new BadRequestException('只能为自己的任务创建提醒');
    }

    // 1. 再次重算 + 过滤名单
    await this.attendance.recomputeTask(params.taskId);
    let { list } = await this.attendance.listNeedReminder({
      taskId: params.taskId,
      viewerUserId: params.operatorId,
      type:
        params.templateType === MessageTemplateType.NEVER_ENTERED
          ? 'not_entered'
          : 'incomplete',
      excludeUnmatchedIdentity: true,
      pageSize: 10000,
    });
    if (params.rosterIds && params.rosterIds.length) {
      const set = new Set(params.rosterIds);
      list = list.filter((r) => set.has(r.id));
    }
    if (list.length === 0) {
      throw new BadRequestException('没有需要提醒的学生');
    }
    if (list.length > 10000) {
      throw new BadRequestException('企业微信单次最多10000人，请分批');
    }

    // 2. 提醒规则校验
    for (const r of list) {
      const err = await this.rules.canCreateReminder({
          task,
          customerId: r.customerId,
          reminderCount: r.reminderCount,
          maxReminders: task.maxRemindersPerStudent,
        });
      if (err) throw new BadRequestException(err);
    }

    // 3. 防重复：同任务 + 同状态 + 今天已有结果未知的任务 → 拒绝
    const dupBlock = await this.redis.safeGet(
      `reminder:dup:${params.taskId}:${params.operatorId}:${new Date().toISOString().slice(0, 10)}`,
    );
    if (dupBlock) {
      const prev = JSON.parse(dupBlock);
      const bad = await this.prisma.wecomGroupMessageTask.findUnique({
        where: { id: prev.taskId },
        select: { status: true },
      });
      if (bad && bad.status === GroupMessageStatus.UNKNOWN) {
        throw new BadRequestException(
          '今天已存在结果未知的提醒任务，请勿重复创建。请先刷新状态。',
        );
      }
    }

    // 4. 组装文案/链接
    const baseUrl =
      this.config.get<string>('TRANSFER_PAGE_BASE_URL') || 'http://localhost:5173';
    const finalUrl = `${baseUrl}/course/${task.course.feiceLiveRoomId}`;
    const tmpl = await this.getDefaultTemplate(params.templateType);
    const finalContent = params.customContent?.trim() || tmpl?.content || '';
    const entryType = params.entryType ?? (task.course.status === 'ENDED' ? 'replay' : 'live');

    // 5. 持久化草稿
    const taskNo = `MSG${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const groupTask = await this.prisma.wecomGroupMessageTask.create({
      data: {
        taskNo,
        monitoringTaskId: params.taskId,
        createdBySalesId: params.operatorId,
        templateId: tmpl?.id,
        templateVersion: tmpl?.version ?? 1,
        templateType: params.templateType,
        finalContent,
        finalUrl,
        entryType,
        status: GroupMessageStatus.DRAFT,
        totalRecipients: list.length,
        recipients: {
          create: list.map((r) => ({
            rosterEntryId: r.id,
            customerId: r.customerId,
            externalUserid: r.customer.externalUserid,
          })),
        },
      },
      include: { recipients: true },
    });

    // 6. 提交企业微信
    try {
      await this.wecomGroup.submitToWecom(groupTask.id);
    } catch (e: any) {
      await this.prisma.wecomGroupMessageTask.update({
        where: { id: groupTask.id },
        data: { status: GroupMessageStatus.FAILED },
      });
      throw e;
    }

    // 7. 更新 roster 提醒计数
    const ids = list.map((r) => r.id);
    await this.prisma.courseRoster.updateMany({
      where: { id: { in: ids } },
      data: {
        reminderCount: { increment: 1 },
        lastReminderAt: new Date(),
      },
    });

    // 8. 防重复缓存
    await this.redis.safeSet(
      `reminder:dup:${params.taskId}:${params.operatorId}:${new Date().toISOString().slice(0, 10)}`,
      JSON.stringify({ taskId: groupTask.id, at: Date.now() }),
      24 * 3600,
    );
    // 每个学生+任务+日期锁
    for (const r of list) {
      await this.redis.safeSet(
        `reminder:daily:${params.taskId}:${r.customerId}:${new Date().toISOString().slice(0, 10)}`,
        '1',
        24 * 3600,
      );
    }

    await this.audit.log({
      userId: params.operatorId,
      action: 'create_group_reminder',
      targetType: 'message_task',
      targetId: groupTask.id,
      detail: JSON.stringify({
        rosterTaskId: params.taskId,
        recipients: list.length,
        templateType: params.templateType,
      }),
    });
    return { ok: true, messageTask: groupTask };
  }

  /** 销售工作台：我名下的群发任务 */
  async listMyMessageTasks(salesUserId: number, status?: GroupMessageStatus) {
    const where: any = { createdBySalesId: salesUserId };
    if (status) where.status = status;
    return this.prisma.wecomGroupMessageTask.findMany({
      where,
      include: {
        monitoringTask: {
          include: { course: { select: { id: true, name: true } } },
        },
        _count: { select: { recipients: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMessageTaskDetail(taskId: number, viewerUserId: number) {
    const t = await this.prisma.wecomGroupMessageTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        recipients: {
          include: {
            customer: {
              select: {
                id: true,
                nickname: true,
                avatar: true,
                externalUserid: true,
              },
            },
            roster: true,
          },
          take: 500,
        },
        monitoringTask: { include: { course: true } },
      },
    });
    if (t.createdBySalesId !== viewerUserId) {
      // TODO: 主管放行
      throw new BadRequestException('无权查看');
    }
    return t;
  }

  /** 刷新任务状态 */
  refreshMessageTask(taskId: number) {
    return this.wecomGroup.refreshTaskStatus(taskId);
  }

  /** 停止任务 */
  async stopMessageTask(taskId: number, operatorId: number) {
    const t = await this.prisma.wecomGroupMessageTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    if (t.createdBySalesId !== operatorId) {
      throw new BadRequestException('无权操作');
    }
    const r = await this.wecomGroup.cancelTask(taskId);
    await this.audit.log({
      userId: operatorId,
      action: 'stop_group_reminder',
      targetType: 'message_task',
      targetId: taskId,
    });
    return r;
  }

  /** 手动停止某个学生的后续提醒 */
  async stopForStudent(params: {
    taskId: number;
    customerId: number;
    operatorId: number;
    reason?: string;
  }) {
    const r = await this.prisma.courseRoster.updateMany({
      where: {
        taskId: params.taskId,
        customerId: params.customerId,
      },
      data: {
        stopReminder: true,
        stopReason: params.reason ?? 'manual',
        stoppedAt: new Date(),
        status: RosterEntryStatus.STOPPED,
      },
    });
    await this.audit.log({
      userId: params.operatorId,
      action: 'stop_reminder_one',
      targetType: 'roster',
      targetId: params.taskId,
      detail: JSON.stringify({ customerId: params.customerId, reason: params.reason }),
    });
    return { updated: r.count };
  }

  // ============ 快捷群发 ============

  /**
   * 快捷群发：不建监控任务，直接选客户 + 写文案 + 发送
   * MVP 流程：选人 → 写文案+网址 → 提交企微 → 销售手机确认 → 客户收到
   */
  async quickSend(params: {
    operatorId: number;
    content: string;
    url: string;
    customerIds: number[];
    linkTitle?: string;
  }) {
    const { content, url, customerIds, linkTitle = '点击进入' } = params;
    if (!content?.trim()) throw new BadRequestException('文案不能为空');
    if (!url?.trim()) throw new BadRequestException('网址不能为空');
    if (!customerIds?.length) throw new BadRequestException('请至少选择一位客户');
    if (customerIds.length > 10000) throw new BadRequestException('单次最多 10000 人');

    // 查客户（只取属于该销售名下的有效客户）
    const customers = await this.prisma.customer.findMany({
      where: {
        id: { in: customerIds },
        isDeleted: false,
        relations: { some: { salesUserId: params.operatorId, status: 'active' } },
      },
      select: { id: true, externalUserid: true, nickname: true },
    });
    if (customers.length === 0) throw new BadRequestException('选中的客户均不在你名下');

    const taskNo = `QS${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const groupTask = await this.prisma.wecomGroupMessageTask.create({
      data: {
        taskNo,
        monitoringTaskId: null,
        createdBySalesId: params.operatorId,
        templateType: MessageTemplateType.CUSTOM,
        finalContent: content.trim(),
        finalUrl: url.trim(),
        entryType: 'live',
        status: GroupMessageStatus.DRAFT,
        totalRecipients: customers.length,
        recipients: {
          create: customers.map((c) => ({
            customerId: c.id,
            externalUserid: c.externalUserid,
          })),
        },
      },
      include: { recipients: true },
    });

    try {
      await this.wecomGroup.submitToWecom(groupTask.id);
    } catch (e: any) {
      await this.prisma.wecomGroupMessageTask.update({
        where: { id: groupTask.id },
        data: { status: GroupMessageStatus.FAILED },
      });
      throw e;
    }

    await this.audit.log({
      userId: params.operatorId,
      action: 'quick_send',
      targetType: 'message_task',
      targetId: groupTask.id,
      detail: JSON.stringify({ recipients: customers.length }),
    });

    return { messageTask: groupTask };
  }

  // ============ 模板 ============
  async getDefaultTemplate(type: MessageTemplateType) {
    return this.prisma.messageTemplate.findFirst({
      where: { type, isDefault: true, isActive: true },
      orderBy: { version: 'desc' },
    });
  }

  async listTemplates() {
    return this.prisma.messageTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
    });
  }

  /** 首次启动时确保两套默认模板存在 */
  async seedDefaultTemplatesIfEmpty() {
    const count = await this.prisma.messageTemplate.count();
    if (count > 0) return;
    await this.prisma.messageTemplate.createMany({
      data: [
        {
          name: '默认-从未进入',
          type: MessageTemplateType.NEVER_ENTERED,
          content:
            '你报名的课程还没有开始学习，点击下方入口即可进入课程。完成学习要求后，系统将自动停止提醒。',
          isDefault: true,
          version: 1,
        },
        {
          name: '默认-听课不足',
          type: MessageTemplateType.INCOMPLETE,
          content:
            '你参加的课程尚未完成，可以点击下方入口继续学习。达到课程学习要求后，系统将自动停止提醒。',
          isDefault: true,
          version: 1,
        },
      ],
    });
  }
}
