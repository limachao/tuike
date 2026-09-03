import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';

@Controller('attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('recompute/task/:taskId')
  recomputeTask(@Param('taskId') taskId: string) {
    return this.attendance.recomputeTask(Number(taskId));
  }

  @Get('tasks/:taskId/need-reminder')
  listNeedReminder(
    @Param('taskId') taskId: string,
    @Query()
    q: {
      type?: 'not_entered' | 'incomplete' | 'all';
      keyword?: string;
      page?: string;
      pageSize?: string;
      excludeUnmatchedIdentity?: string;
    },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.attendance.listNeedReminder({
      taskId: Number(taskId),
      viewerUserId: u.sub,
      type: q.type,
      keyword: q.keyword,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 100,
      excludeUnmatchedIdentity: q.excludeUnmatchedIdentity === '1',
    });
  }
}
