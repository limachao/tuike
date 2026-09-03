import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface AuditInput {
  userId?: number;
  userName?: string;
  action: string;
  targetType?: string;
  targetId?: number;
  detail?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  log(input: AuditInput) {
    return this.prisma.auditLog.create({
      data: {
        userId: input.userId,
        userName: input.userName,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        detail: input.detail,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    });
  }
}
