import { Module, Global } from '@nestjs/common';
import { WecomApiService } from './wecom-api.service';
import { WecomSyncService } from './wecom-sync.service';
import { WecomController } from './wecom.controller';
import { WecomGroupMessageService } from './wecom-group-message.service';
import { RedisModule } from '../common/redis/redis.module';
import { UsersModule } from '../users/users.module';

@Global()
@Module({
  imports: [RedisModule, UsersModule],
  providers: [WecomApiService, WecomSyncService, WecomGroupMessageService],
  controllers: [WecomController],
  exports: [WecomApiService, WecomSyncService, WecomGroupMessageService],
})
export class WecomModule {}
