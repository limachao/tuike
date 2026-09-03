import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { CoursesModule } from '../courses/courses.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [CoursesModule, IdentityModule],
  providers: [AttendanceService],
  controllers: [AttendanceController],
  exports: [AttendanceService],
})
export class AttendanceModule {}
