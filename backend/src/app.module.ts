import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WecomModule } from './wecom/wecom.module';
import { FeiceModule } from './feice/feice.module';
import { IdentityModule } from './identity/identity.module';
import { CoursesModule } from './courses/courses.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ReminderModule } from './reminder/reminder.module';
import { TransferModule } from './transfer/transfer.module';
import { AuditModule } from './audit/audit.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    // 配置
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
    }),
    ScheduleModule.forRoot(),
    // 公共
    PrismaModule,
    RedisModule,
    // 业务模块
    AuthModule,
    UsersModule,
    WecomModule,
    FeiceModule,
    IdentityModule,
    CoursesModule,
    AttendanceModule,
    ReminderModule,
    TransferModule,
    AuditModule,
    SyncModule,
  ],
})
export class AppModule {}
