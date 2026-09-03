import { Module, Global } from '@nestjs/common';
import { FeiceApiService } from './feice-api.service';
import { FeiceSyncService } from './feice-sync.service';
import { FeiceInviteService } from './feice-invite.service';
import { FeiceController } from './feice.controller';
import { RedisModule } from '../common/redis/redis.module';

@Global()
@Module({
  imports: [RedisModule],
  providers: [FeiceApiService, FeiceSyncService, FeiceInviteService],
  controllers: [FeiceController],
  exports: [FeiceApiService, FeiceSyncService, FeiceInviteService],
})
export class FeiceModule {}
