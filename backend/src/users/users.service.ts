import { Injectable } from '@nestjs/common';
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
}
