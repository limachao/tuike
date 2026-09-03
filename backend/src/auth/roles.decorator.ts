import { SetMetadata } from '@nestjs/common';

export type UserRoleStr = 'SALES' | 'SUPERVISOR' | 'SUPER_ADMIN';

export const Roles = (...roles: UserRoleStr[]) =>
  SetMetadata('roles', roles);
