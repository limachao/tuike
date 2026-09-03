import { Module } from '@nestjs/common';
import { ReminderService } from './reminder.service';
import { ReminderController } from './reminder.controller';
import { ReminderRuleService } from './reminder-rule.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { CoursesModule } from '../courses/courses.module';
import { IdentityModule } from '../identity/identity.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AttendanceModule, CoursesModule, IdentityModule, UsersModule],
  providers: [ReminderService, ReminderRuleService],
  controllers: [ReminderController],
  exports: [ReminderService, ReminderRuleService],
})
export class ReminderModule {}
