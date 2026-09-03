import { Module } from '@nestjs/common';
import { TransferService } from './transfer.service';
import { TransferController } from './transfer.controller';
import { CoursesModule } from '../courses/courses.module';
import { ReminderModule } from '../reminder/reminder.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [CoursesModule, ReminderModule, IdentityModule],
  providers: [TransferService],
  controllers: [TransferController],
  exports: [TransferService],
})
export class TransferModule {}
