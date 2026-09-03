import { Controller, Post, UseGuards, Param, Body } from '@nestjs/common';
import { WecomSyncService } from './wecom-sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';

@Controller('wecom')
@UseGuards(JwtAuthGuard)
export class WecomController {
  constructor(private readonly sync: WecomSyncService) {}

  @Post('sync/users')
  syncUsers(@CurrentUser() u: JwtUserPayload) {
    return this.sync.syncUsers(u.sub);
  }

  @Post('sync/my-customers')
  syncMyCustomers(@CurrentUser() u: JwtUserPayload) {
    return this.sync.syncCustomersForSales(u.sub, u.sub);
  }

  @Post('sync/customers/:salesId')
  syncCustomers(
    @Param('salesId') salesId: string,
    @CurrentUser() u: JwtUserPayload,
  ) {
    // 主管可同步任意销售；销售只能同步自己
    if (u.role !== 'SUPERVISOR' && Number(salesId) !== u.sub) {
      return this.sync.syncCustomersForSales(u.sub, u.sub);
    }
    return this.sync.syncCustomersForSales(Number(salesId), u.sub);
  }
}
