import {
  Controller,
  Post,
  UseGuards,
  Param,
  Logger,
} from '@nestjs/common';
import { WecomSyncService } from './wecom-sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';

@Controller('wecom')
@UseGuards(JwtAuthGuard)
export class WecomController {
  private readonly logger = new Logger(WecomController.name);

  constructor(private readonly sync: WecomSyncService) {}

  @Post('sync/users')
  syncUsers(@CurrentUser() u: JwtUserPayload) {
    return this.sync.syncUsers(u.sub);
  }

  /**
   * 客户同步改为后台执行：客户量大（数千人）时耗时数分钟，
   * 同步结果写入 sync_log，接口立即返回避免网关超时。
   */
  @Post('sync/my-customers')
  syncMyCustomers(@CurrentUser() u: JwtUserPayload) {
    this.runInBackground(() => this.sync.syncCustomersForSales(u.sub, u.sub), u.sub);
    return { started: true, message: '客户同步已在后台开始，预计几分钟，完成后刷新页面' };
  }

  @Post('sync/customers/:salesId')
  syncCustomers(
    @Param('salesId') salesId: string,
    @CurrentUser() u: JwtUserPayload,
  ) {
    // 主管可同步任意销售；销售只能同步自己
    const targetId =
      u.role !== 'SUPERVISOR' && Number(salesId) !== u.sub
        ? u.sub
        : Number(salesId);
    this.runInBackground(() => this.sync.syncCustomersForSales(targetId, u.sub), u.sub);
    return { started: true, message: '客户同步已在后台开始，预计几分钟，完成后刷新页面' };
  }

  private runInBackground(task: () => Promise<any>, operatorId: number) {
    void task().catch((e) => {
      this.logger.error(
        `后台客户同步失败 operator=${operatorId}: ${e?.message}`,
        e?.stack,
      );
    });
  }
}
