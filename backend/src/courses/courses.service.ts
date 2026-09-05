import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RosterEntryStatus } from '@prisma/client';
import { AuditLogService } from '../audit/audit-log.service';

/**
 * 课程监控任务服务：
 * - 创建任务（绑定课程 + 销售）
 * - 展示销售名下客户（一键全选）
 * - 批量加入 / 排除 / 确认名单快照
 * - 新增客户加入未开始课程
 */
@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** 创建课程监控任务（不包含名单） */
  async createTask(params: {
    courseId: number;
    salesUserId: number;
    taskName?: string;
    completeDurationPercent?: number;
    completeProgressPercent?: number;
    maxRemindersPerStudent?: number;
  }) {
    const course = await this.prisma.course.findUnique({
      where: { id: params.courseId },
    });
    if (!course) throw new NotFoundException('课程不存在');

    const task = await this.prisma.courseMonitoringTask.create({
      data: {
        courseId: params.courseId,
        createdBySalesId: params.salesUserId,
        taskName: params.taskName ?? course.name,
        completeDurationPercent: params.completeDurationPercent ?? 60,
        completeProgressPercent: params.completeProgressPercent ?? 60,
        maxRemindersPerStudent: params.maxRemindersPerStudent ?? 3,
      },
    });
    await this.audit.log({
      userId: params.salesUserId,
      action: 'create_course_task',
      targetType: 'task',
      targetId: task.id,
      detail: JSON.stringify({ courseId: params.courseId }),
    });
    return task;
  }

  /** 获取客户列表（主管/超管可看全部，销售只能看自己名下的） */
  async listCustomers(viewerUserId: number, viewerRole: string, keyword?: string) {
    const where: any = { isDeleted: false };
    const isAdmin = viewerRole === 'SUPERVISOR' || viewerRole === 'SUPER_ADMIN';
    if (!isAdmin) {
      // 名下 = 与该销售存在有效归属关系（owner 可能已因删除/继承转交）
      where.relations = {
        some: { salesUserId: viewerUserId, status: 'active' },
      };
    }
    if (keyword) {
      where.OR = [
        { nickname: { contains: keyword, mode: 'insensitive' } },
        { externalUserid: { contains: keyword } },
        { remarkMobiles: { contains: keyword } },
      ];
    }
    const list = await this.prisma.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20000,
    });
    return { total: list.length, list };
  }

  /** 销售获取自己名下客户列表（供任务创建用） */
  async listMyCustomers(salesUserId: number, keyword?: string) {
    return this.listCustomers(salesUserId, 'SALES', keyword);
  }

  /**
   * 一键将销售名下全部客户加入任务（未排除=未确认，可再微调）
   * joinMethod = select_all
   */
  async selectAllCustomersToTask(taskId: number, salesUserId: number, viewerRole?: string) {
    const task = await this.getTaskIfAllowed(taskId, salesUserId, viewerRole);
    const { list } = await this.listCustomers(salesUserId, viewerRole || 'SALES');
    // 批量插入，已存在的（含之前排除/加入的）自动跳过
    const result = await this.prisma.courseRoster.createMany({
      data: list.map((c) => ({
        taskId,
        customerId: c.id,
        ownerUserIdAtJoin: salesUserId,
        joinMethod: 'select_all' as const,
      })),
      skipDuplicates: true,
    });
    const added = result.count;
    if (added > 0) {
      await this.prisma.courseMonitoringTask.update({
        where: { id: taskId },
        data: { totalRosterCount: { increment: added } },
      });
    }
    await this.audit.log({
      userId: salesUserId,
      action: 'roster_select_all',
      targetType: 'task',
      targetId: taskId,
      detail: JSON.stringify({ added, pool: list.length }),
    });
    return { added, pool: list.length };
  }

  /** 单独从任务中排除/移除 */
  async excludeFromTask(params: {
    taskId: number;
    customerIds: number[];
    reason?: string;
    operatorId: number;
    operatorRole?: string;
  }) {
    await this.getTaskIfAllowed(params.taskId, params.operatorId, params.operatorRole);
    const r = await this.prisma.courseRoster.updateMany({
      where: {
        taskId: params.taskId,
        customerId: { in: params.customerIds },
      },
      data: {
        isExcluded: true,
        excludeReason: params.reason ?? '手动排除',
        excludedBy: params.operatorId,
        excludedAt: new Date(),
        status: RosterEntryStatus.EXCLUDED,
      },
    });
    await this.prisma.courseMonitoringTask.update({
      where: { id: params.taskId },
      data: { excludedCount: { increment: r.count } },
    });
    await this.audit.log({
      userId: params.operatorId,
      action: 'roster_exclude',
      targetType: 'task',
      targetId: params.taskId,
      detail: JSON.stringify({
        customerIds: params.customerIds,
        reason: params.reason,
      }),
    });
    return { updated: r.count };
  }

  /** 手动加入单个客户 */
  async addCustomerToTask(params: {
    taskId: number;
    customerId: number;
    salesUserId: number;
    viewerRole?: string;
    joinMethod?: string;
  }) {
    await this.getTaskIfAllowed(params.taskId, params.salesUserId, params.viewerRole);
    try {
      await this.prisma.courseRoster.create({
        data: {
          taskId: params.taskId,
          customerId: params.customerId,
          ownerUserIdAtJoin: params.salesUserId,
          joinMethod: params.joinMethod ?? 'manual',
          isExcluded: false,
          status: RosterEntryStatus.IN_LIST,
        },
      });
      await this.prisma.courseMonitoringTask.update({
        where: { id: params.taskId },
        data: { totalRosterCount: { increment: 1 } },
      });
    } catch (e) {
      // unique conflict -> reset excluded
      await this.prisma.courseRoster.updateMany({
        where: { taskId: params.taskId, customerId: params.customerId },
        data: { isExcluded: false, excludeReason: null, excludedBy: null, excludedAt: null, status: RosterEntryStatus.IN_LIST },
      });
    }
    return { ok: true };
  }

  /** 销售确认名单 — 快照确定，后续新增客户需再次确认 */
  async finalizeRoster(taskId: number, salesUserId: number, viewerRole?: string) {
    await this.getTaskIfAllowed(taskId, salesUserId, viewerRole);
    // 统计当前人数
    const [total, excluded] = await Promise.all([
      this.prisma.courseRoster.count({ where: { taskId } }),
      this.prisma.courseRoster.count({ where: { taskId, isExcluded: true } }),
    ]);
    await this.prisma.courseMonitoringTask.update({
      where: { id: taskId },
      data: {
        totalRosterCount: total,
        excludedCount: excluded,
        rosterFinalizedAt: new Date(),
        isActive: true,
      },
    });
    await this.audit.log({
      userId: salesUserId,
      action: 'roster_finalize',
      targetType: 'task',
      targetId: taskId,
      detail: JSON.stringify({ total, excluded }),
    });
    return { ok: true, total, excluded };
  }

  /** 查看任务的应听名单（分页 + 状态筛选） */
  async listRoster(params: {
    taskId: number;
    viewerUserId: number;
    viewerRole?: string;
    status?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }) {
    const task = await this.getTaskIfAllowed(params.taskId, params.viewerUserId, params.viewerRole);
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 50, 10000);

    const where: any = { taskId: params.taskId };
    if (params.status) where.status = params.status;

    const customerWhere: any = {};
    if (params.keyword) {
      customerWhere.OR = [
        { nickname: { contains: params.keyword, mode: 'insensitive' } },
        { externalUserid: { contains: params.keyword } },
      ];
    }
    if (Object.keys(customerWhere).length) where.customer = customerWhere;

    const [list, total] = await Promise.all([
      this.prisma.courseRoster.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              nickname: true,
              avatar: true,
              externalUserid: true,
              studentId: true,
            },
          },
        },
        orderBy: { joinedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.courseRoster.count({ where }),
    ]);
    return { list, total, page, pageSize, task };
  }

  /** 任务列表：主管/超管可看全部，销售只能看自己创建的 */
  async listMyTasks(viewerUserId: number, viewerRole: string, isActive?: boolean) {
    const isAdmin = viewerRole === 'SUPERVISOR' || viewerRole === 'SUPER_ADMIN';
    const where: any = {};
    if (!isAdmin) where.createdBySalesId = viewerUserId;
    if (isActive !== undefined) where.isActive = isActive;
    return this.prisma.courseMonitoringTask.findMany({
      where,
      include: {
        course: {
          select: {
            id: true,
            name: true,
            coverUrl: true,
            startTime: true,
            status: true,
            totalDuration: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 删除监控任务（创建人本人或主管/超管）。
   * 名单、群发任务及发送明细均随外键级联删除，不可恢复。
   */
  async deleteTask(taskId: number, viewerUserId: number, viewerRole: string) {
    const task = await this.getTaskIfAllowed(taskId, viewerUserId, viewerRole);
    await this.prisma.courseMonitoringTask.delete({ where: { id: task.id } });
    await this.audit.log({
      userId: viewerUserId,
      action: 'delete_course_task',
      targetType: 'task',
      targetId: taskId,
      detail: JSON.stringify({ taskName: task.taskName, courseId: task.courseId }),
    });
    return { deleted: taskId, taskName: task.taskName };
  }

  /** 权限检查：主管/超管可看全部，销售只能看自己的 */
  async getTaskIfAllowed(taskId: number, viewerUserId: number, viewerRole?: string) {
    const task = await this.prisma.courseMonitoringTask.findUnique({
      where: { id: taskId },
      include: { createdBy: { select: { id: true, role: true } } },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const isAdmin = viewerRole === 'SUPERVISOR' || viewerRole === 'SUPER_ADMIN';
    if (task.createdBySalesId !== viewerUserId && !isAdmin) {
      throw new ForbiddenException('无权访问该任务');
    }
    return task;
  }
}
