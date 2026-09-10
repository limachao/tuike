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
   * 快捷群发客户列表：带飞策听课总时长 + 加入企微日期（当前销售的有效关系）
   * 支持昵称/手机号搜索、按加入企微日期区间筛选
   */
  async quickSendCustomers(params: {
    operatorId: number;
    keyword?: string;
    addFrom?: string; // YYYY-MM-DD，北京时间
    addTo?: string;
  }) {
    // 关键词/日期过滤已移到前端本地执行（数据一次性下发），服务端只做归属查询
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT c.id,
             c.nickname,
             c."remarkMobiles" AS remark_mobiles,
             c.wecom_tags AS wecom_tags,
             r."addTime" AS add_time,
             (COALESCE(s."liveSec", 0) + COALESCE(s."replaySec", 0))::int AS listen_sec
      FROM customers c
      JOIN customer_sales_relations r
        ON r."customerId" = c.id
       AND r."salesUserId" = ${params.operatorId}
       AND r.status = 'active'
      LEFT JOIN customer_listen_stats s ON s."customerId" = c.id
      WHERE c."isDeleted" = false
      ORDER BY r."addTime" DESC NULLS LAST
    `;

    return rows.map((r) => ({
      id: Number(r.id),
      nickname: r.nickname,
      remarkMobiles: r.remark_mobiles,
      addTime: r.add_time,
      listenSec: Number(r.listen_sec ?? 0),
      // 企微客户标签名数组（同步时写入，JSON 字符串）
      wecomTags: this.parseTagArray(r.wecom_tags),
    }));
  }

  /**
   * 解析 wecom_tags JSON，返回全部企微标签名（含企业公共标签和销售个人标签）。
   *
   * 兼容两种存储格式：
   *   新格式：[{"name":"意向强","group":"我的标签组"}, ...]
   *   旧格式（升级前）：["24年客户", "王老师抖音", ...] —— 旧格式全部忽略
   */
  private parseTagArray(raw: unknown): string[] {
    if (!raw || typeof raw !== 'string') return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((t) => {
          // 新格式：带 group 的对象
          if (t && typeof t === 'object' && 'name' in t && 'group' in t) {
            const n: string = String((t as any).name ?? '').trim();
            if (n) return n;
          }
          return null;
        })
        .filter((x): x is string => !!x);
    } catch {
      return [];
    }
  }

  /**
   * 快捷群发：不建监控任务，直接选客户 + 写文案 + 发送
   * MVP 流程：选人 → 写文案+网址 → 提交企微 → 销售手机确认 → 客户收到
   */
  async quickSend(params: {
    operatorId: number;
    content: string;
    url?: string;
    customerIds: number[];
    linkTitle?: string;
    /** 定时发送：ISO 时间字符串。传入则只存库（状态 SCHEDULED），到点由 cron 自动提交企微 */
    scheduledAt?: string;
  }) {
    const { content, customerIds, linkTitle = '点击进入' } = params;
    const url = params.url?.trim() ?? '';
    if (!content?.trim()) throw new BadRequestException('文案不能为空');
    if (!customerIds?.length) throw new BadRequestException('请至少选择一位客户');
    if (customerIds.length > 10000) throw new BadRequestException('单次最多 10000 人');

    // 定时时间校验：必须是未来 2 分钟 ~ 30 天之间
    let scheduledDate: Date | null = null;
    if (params.scheduledAt) {
      const d = new Date(params.scheduledAt);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('定时时间格式不正确');
      const diffMs = d.getTime() - Date.now();
      if (diffMs < 2 * 60 * 1000) {
        throw new BadRequestException('定时发送时间至少要在 2 分钟之后');
      }
      if (diffMs > 30 * 24 * 60 * 60 * 1000) {
        throw new BadRequestException('定时发送最远只能设置 30 天');
      }
      scheduledDate = d;
    }

    // 文案字节校验：企微 text.content 最多 4000 字节（UTF-8，中文 1 字 ≈ 3 字节）
    const contentBytes = Buffer.byteLength(content.trim(), 'utf8');
    if (contentBytes > 4000) {
      throw new BadRequestException(
        `文案太长（${contentBytes} 字节），企业微信限制最多 4000 字节（约 1300 汉字）`,
      );
    }
    // 链接字节校验：企微 link.url 最多 2048 字节
    if (url && Buffer.byteLength(url, 'utf8') > 2048) {
      throw new BadRequestException(`链接太长，企业微信限制最多 2048 字节`);
    }

    // 防重复提交锁：同一销售 10 秒内只能提交一次
    const dedupKey = `quick-send:${params.operatorId}:${Date.now().toString().slice(0, -1)}`; // 10 秒粒度
    const acquired = await this.redis.safeGet(dedupKey);
    if (acquired) {
      throw new BadRequestException('正在提交中，请勿重复点击');
    }
    await this.redis.safeSet(dedupKey, '1', 15); // 15 秒 TTL

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

    // 过滤掉没有企微 externalUserid 的客户（企微 API 不认，会整体报错）
    const validCustomers = customers.filter(
      (c) => c.externalUserid && c.externalUserid.trim().length > 0,
    );
    const skipped = customers.length - validCustomers.length;
    if (validCustomers.length === 0) {
      throw new BadRequestException(
        `选中的 ${customers.length} 位客户都还未绑定企业微信，无法发送。请先同步客户信息。`,
      );
    }
    if (skipped > 0) {
      this.logger.warn(
        `快捷群发跳过 ${skipped} 位未绑定企微的客户（总共选了 ${customers.length} 位）`,
      );
    }

    const taskNo = `QS${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // ===== 定时发送：名单/文案当场冻结存库，不调企微；到点由 cron 自动提交 =====
    if (scheduledDate) {
      const groupTask = await this.prisma.wecomGroupMessageTask.create({
        data: {
          taskNo,
          monitoringTaskId: null,
          createdBySalesId: params.operatorId,
          templateType: MessageTemplateType.CUSTOM,
          finalContent: content.trim(),
          finalUrl: url,
          entryType: 'live',
          status: GroupMessageStatus.SCHEDULED,
          scheduledAt: scheduledDate,
          totalRecipients: validCustomers.length,
        },
      });
      await this.prisma.wecomGroupMessageRecipient.createMany({
        data: validCustomers.map((c) => ({
          messageTaskId: groupTask.id,
          customerId: c.id,
          externalUserid: c.externalUserid!,
        })),
        skipDuplicates: true,
      });
      await this.audit.log({
        userId: params.operatorId,
        action: 'quick_send_scheduled',
        targetType: 'message_task',
        targetId: groupTask.id,
        detail: JSON.stringify({ recipients: validCustomers.length, scheduledAt: scheduledDate.toISOString() }),
      });
      return { messageTask: groupTask, scheduled: true };
    }

    // 先调企微 API（同步创建任务，通常 2-5 秒返回 msgid）。
    // 成功后再写数据库——避免 DB 写了但企微没发的半残状态。
    let wecomResult: { msgid: string; failList?: string[] };
    try {
      wecomResult = await this.wecomGroup.submitToWecomDraft(
        params.operatorId,
        content.trim(),
        url,
        validCustomers.map((c) => c.externalUserid!),
        linkTitle,
      );
    } catch (e: any) {
      throw new BadRequestException(`企微创建群发任务失败: ${e.message ?? e}`);
    }

    // DB 写入分两步：先写主记录（DRAFT），再批量写 recipient。
    // Prisma createMany 会用 unnest 批量插入，6000 条只需 1-2 秒。
    const groupTask = await this.prisma.wecomGroupMessageTask.create({
      data: {
        taskNo,
        monitoringTaskId: null,
        createdBySalesId: params.operatorId,
        templateType: MessageTemplateType.CUSTOM,
        finalContent: content.trim(),
        finalUrl: url,
        entryType: 'live',
        status: GroupMessageStatus.PENDING_CONFIRM,
        wecomMsgid: wecomResult.msgid,
        wecomCreatedAt: new Date(),
        totalRecipients: validCustomers.length,
        failList: wecomResult.failList ? JSON.stringify(wecomResult.failList) : undefined,
        sentFailCount: wecomResult.failList?.length ?? 0,
      },
    });

    await this.prisma.wecomGroupMessageRecipient.createMany({
      data: validCustomers.map((c) => ({
        messageTaskId: groupTask.id,
        customerId: c.id,
        externalUserid: c.externalUserid!,
      })),
      skipDuplicates: true,
    });

    await this.audit.log({
      userId: params.operatorId,
      action: 'quick_send',
      targetType: 'message_task',
      targetId: groupTask.id,
      detail: JSON.stringify({ recipients: customers.length }),
    });

    return { messageTask: groupTask };
  }

  /**
   * 定时任务到点执行（由 cron 每分钟调用）：
   * 把冻结的名单/文案提交企微，成功后状态转 PENDING_CONFIRM（销售手机确认）。
   * 失败自动重试，最多 3 次；仍失败标记 FAILED 并记录原因。
   */
  async executeScheduledTask(taskId: number): Promise<{ ok: boolean; error?: string }> {
    const task = await this.prisma.wecomGroupMessageTask.findUnique({
      where: { id: taskId },
    });
    if (!task || task.status !== GroupMessageStatus.SCHEDULED) {
      return { ok: true }; // 已取消/已执行，幂等跳过
    }

    // 执行前重新校验名单：客户已删除或已不在该销售名下的跳过
    const recipients = await this.prisma.wecomGroupMessageRecipient.findMany({
      where: { messageTaskId: taskId },
      select: { customerId: true },
    });
    const validCustomers = await this.prisma.customer.findMany({
      where: {
        id: { in: recipients.map((r) => r.customerId) },
        isDeleted: false,
        externalUserid: { not: '' },
        relations: {
          some: { salesUserId: task.createdBySalesId, status: 'active' },
        },
      },
      select: { id: true, externalUserid: true },
    });
    const extIds = validCustomers.map((c) => c.externalUserid!).filter(Boolean);

    if (extIds.length === 0) {
      const msg = '定时执行时名单中已无有效客户（均已删除或不在该销售名下）';
      await this.prisma.wecomGroupMessageTask.update({
        where: { id: taskId },
        data: { status: GroupMessageStatus.FAILED, scheduleError: msg },
      });
      this.logger.error(`[定时发送] 任务#${taskId} 执行失败：${msg}`);
      return { ok: false, error: msg };
    }

    try {
      const wecomResult = await this.wecomGroup.submitToWecomDraft(
        task.createdBySalesId,
        task.finalContent,
        task.finalUrl || '',
        extIds,
        '点击进入',
      );
      await this.prisma.wecomGroupMessageTask.update({
        where: { id: taskId },
        data: {
          status: GroupMessageStatus.PENDING_CONFIRM,
          wecomMsgid: wecomResult.msgid,
          wecomCreatedAt: new Date(),
          totalRecipients: extIds.length,
          failList: wecomResult.failList ? JSON.stringify(wecomResult.failList) : null,
          sentFailCount: wecomResult.failList?.length ?? 0,
          scheduleError: null,
        },
      });
      await this.audit.log({
        userId: task.createdBySalesId,
        action: 'scheduled_send_executed',
        targetType: 'message_task',
        targetId: taskId,
        detail: JSON.stringify({ recipients: extIds.length }),
      });
      this.logger.log(`[定时发送] 任务#${taskId} 已提交企微（${extIds.length} 人），待销售手机确认`);
      return { ok: true };
    } catch (e: any) {
      const attempts = task.scheduleAttempts + 1;
      const msg = String(e?.message ?? e).slice(0, 400);
      const giveUp = attempts >= 3;
      await this.prisma.wecomGroupMessageTask.update({
        where: { id: taskId },
        data: {
          scheduleAttempts: attempts,
          scheduleError: msg,
          ...(giveUp ? { status: GroupMessageStatus.FAILED } : {}),
        },
      });
      this.logger.error(
        `[定时发送] 任务#${taskId} 第 ${attempts} 次提交失败${giveUp ? '，已达上限标记失败' : '，下分钟重试'}: ${msg}`,
      );
      return { ok: false, error: msg };
    }
  }

  /** 取消尚未到点的定时发送任务（销售本人操作） */
  async cancelScheduledTask(taskId: number, operatorId: number) {
    const task = await this.prisma.wecomGroupMessageTask.findUnique({
      where: { id: taskId },
    });
    if (!task) throw new BadRequestException('任务不存在');
    if (task.createdBySalesId !== operatorId) throw new BadRequestException('无权操作');
    if (task.status !== GroupMessageStatus.SCHEDULED) {
      throw new BadRequestException('该任务不是待发送状态，无法取消');
    }
    await this.prisma.wecomGroupMessageTask.update({
      where: { id: taskId },
      data: { status: GroupMessageStatus.STOPPED },
    });
    await this.audit.log({
      userId: operatorId,
      action: 'cancel_scheduled_send',
      targetType: 'message_task',
      targetId: taskId,
    });
    return { ok: true };
  }

  // ============ 模板 ============
  async getDefaultTemplate(type: MessageTemplateType) {
    return this.prisma.messageTemplate.findFirst({
      where: { type, isDefault: true, isActive: true },
      orderBy: { version: 'desc' },
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
