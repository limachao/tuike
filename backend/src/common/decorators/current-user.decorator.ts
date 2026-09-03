import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * 从 JWT Payload 中取出当前登录用户
 * 用法: @CurrentUser() user: JwtUserPayload
 */
export interface JwtUserPayload {
  sub: number;       // userId
  phone: string;
  role: 'SALES' | 'SUPERVISOR' | 'SUPER_ADMIN';
  wecomUserId?: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUserPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as JwtUserPayload;
  },
);
