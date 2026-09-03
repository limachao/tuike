import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { JwtUserPayload } from '../common/decorators/current-user.decorator';
import { AuditLogService } from '../audit/audit-log.service';
import { UserRole } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly audit: AuditLogService,
  ) {}

  /** 手机号+密码登录 */
  async login(phone: string, passwordPlain: string, ip?: string, ua?: string) {
    const user = await this.users.findByPhone(phone);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('手机号或密码错误');
    }
    const ok = await bcrypt.compare(passwordPlain, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    const payload: JwtUserPayload = {
      sub: user.id,
      phone: user.phone,
      role: user.role as UserRole,
      wecomUserId: user.wecomUserId,
    };
    const token = this.jwt.sign(payload);

    await this.users.updateLastLogin(user.id);
    await this.audit.log({
      userId: user.id,
      userName: user.name,
      action: 'login',
      ip,
      userAgent: ua,
      detail: JSON.stringify({ method: 'password' }),
    });

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        avatarUrl: user.avatarUrl,
        wecomUserId: user.wecomUserId,
      },
    };
  }

  /** 主管创建销售账号（首期可用） */
  async registerSales(
    input: { phone: string; password: string; name: string },
    operatorId: number,
  ) {
    const exist = await this.users.findByPhone(input.phone);
    if (exist) {
      throw new ConflictException('该手机号已注册');
    }
    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = await this.users.create({
      phone: input.phone,
      passwordHash,
      name: input.name,
      role: 'SALES',
    });
    await this.audit.log({
      userId: operatorId,
      action: 'create_sales_user',
      targetType: 'user',
      targetId: user.id,
      detail: JSON.stringify({ phone: input.phone, name: input.name }),
    });
    return user;
  }

  /** 初始化根主管（首次启动时使用，若不存在则创建） */
  async initSupervisorIfNeeded(
    defaultPhone: string,
    defaultPassword: string,
  ) {
    const exist = await this.users.findByRoleFirst('SUPERVISOR');
    if (exist) return null;
    const passwordHash = await bcrypt.hash(defaultPassword, 10);
    const u = await this.users.create({
      phone: defaultPhone,
      passwordHash,
      name: '系统主管',
      role: 'SUPERVISOR',
    });
    return u;
  }
}
