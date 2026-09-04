import { Module, Global } from '@nestjs/common';
import { FeiceApiService } from './feice-api.service';
import { FeiceSyncService } from './feice-sync.service';
import { FeiceInviteService } from './feice-invite.service';
import { FeiceController } from './feice.controller';
import { RedisModule } from '../common/redis/redis.module';
import { IdentityModule } from '../identity/identity.module';
import { AttendanceModule } from '../attendance/attendance.module';

@Global()
@Module({
  imports: [RedisModule, IdentityModule, AttendanceModule],
  providers: [FeiceApiService, FeiceSyncService, FeiceInviteService],
  controllers: [FeiceController],
  exports: [FeiceApiService, FeiceSyncService, FeiceInviteService],
})
export class FeiceModule {}
