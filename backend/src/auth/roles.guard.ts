import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtUserPayload } from '../common/decorators/current-user.decorator';

/**
 * 角色守卫: @Roles('SUPERVISOR') + @UseGuards(JwtAuthGuard, RolesGuard)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.get<string[]>('roles', ctx.getHandler());
    if (!roles || roles.length === 0) return true;
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as JwtUserPayload;
    if (!user) throw new ForbiddenException('未登录');
    if (!roles.includes(user.role)) {
      throw new ForbiddenException('权限不足');
    }
    return true;
  }
}
