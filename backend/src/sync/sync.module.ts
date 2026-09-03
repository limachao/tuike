import { Module } from '@nestjs/common';
import { SyncSchedulerService } from './sync-scheduler.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { AuthModule } from '../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { IdentityModule } from '../identity/identity.module';
import { ReminderModule } from '../reminder/reminder.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    AttendanceModule,
    AuthModule,
    CoursesModule,
    IdentityModule,
    ReminderModule,
    UsersModule,
  ],
  providers: [SyncSchedulerService],
  exports: [SyncSchedulerService],
})
export class SyncModule {}
