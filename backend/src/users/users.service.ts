import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { UserRole, Prisma } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByPhone(phone: string) {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  findById(id: number) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByRoleFirst(role: UserRole) {
    return this.prisma.user.findFirst({ where: { role } });
  }

  create(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({ data });
  }

  update(id: number, data: Prisma.UserUpdateInput) {
    return this.prisma.user.update({ where: { id }, data });
  }

  listAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        isActive: true,
        wecomUserId: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  updateLastLogin(id: number) {
    return this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  /** 获取应用可见范围内的销售列表（供课程任务创建用） */
  listActiveSales() {
    return this.prisma.user.findMany({
      where: { isActive: true, role: 'SALES' },
      select: {
        id: true,
        name: true,
        phone: true,
        avatarUrl: true,
        wecomUserId: true,
        hasCustomerContact: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  /** 主管：绑定企业微信 userid */
  bindWecomUser(id: number, wecomUserId: string, hasCustomerContact = true) {
    return this.prisma.user.update({
      where: { id },
      data: { wecomUserId, hasCustomerContact },
    });
  }

  /**
   * 彻底删除账号及其全部相关数据（主管/超管操作）：
   * - 监控任务及其名单、听课记录、群发任务（级联）
   * - 该销售名下的客户归属关系（外键级联）
   * - 审计日志
   */
  async deleteUser(id: number, operator: { sub: number; role: string }) {
    if (id === operator.sub) {
      throw new HttpException('不能删除自己的账号', HttpStatus.BAD_REQUEST);
    }
    const target = await this.findById(id);
    if (!target) {
      throw new HttpException('用户不存在', HttpStatus.NOT_FOUND);
    }
    if (target.role === 'SUPER_ADMIN') {
      throw new HttpException('不能删除超级管理员账号', HttpStatus.FORBIDDEN);
    }
    if (operator.role === 'SUPERVISOR' && target.role !== 'SALES') {
      throw new HttpException('主管只能删除销售账号', HttpStatus.FORBIDDEN);
    }
    await this.prisma.$transaction([
      // 残留名单归属记录（挂在他人任务上、以被删账号为归属人的）
      this.prisma.courseRoster.deleteMany({ where: { ownerUserIdAtJoin: id } }),
      // 该销售创建的群发任务（含接收明细，级联）
      this.prisma.wecomGroupMessageTask.deleteMany({ where: { createdBySalesId: id } }),
      // 该销售创建的监控任务（名单/听课记录/群发任务随之级联删除）
      this.prisma.courseMonitoringTask.deleteMany({ where: { createdBySalesId: id } }),
      // 审计日志
      this.prisma.auditLog.deleteMany({ where: { userId: id } }),
      // 删除账号（客户归属关系随外键级联删除，客户的 owner 置空）
      this.prisma.user.delete({ where: { id } }),
    ]);
    return { deleted: id, name: target.name };
  }
}
