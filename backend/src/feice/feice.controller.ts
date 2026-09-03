import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { FeiceSyncService } from './feice-sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller('feice')
@UseGuards(JwtAuthGuard)
export class FeiceController {
  constructor(
    private readonly sync: FeiceSyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('sync/courses')
  syncCourses(@CurrentUser() u: JwtUserPayload) {
    return this.sync.syncCourses(u.sub);
  }

  @Post('sync/course/:id/live-records')
  syncLiveRecords(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.sync.syncLiveRecords(Number(id), u.sub);
  }

  @Post('sync/course/:id/replay-records')
  syncReplayRecords(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.sync.syncReplayRecords(Number(id), u.sub);
  }

  @Post('sync/invite-records')
  syncInviteRecords(
    @Query('courseId') courseId: string | undefined,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.sync.syncInviteRecords(
      courseId ? Number(courseId) : undefined,
      u.sub,
    );
  }

  @Get('courses')
  listCourses(
    @Query('keyword') keyword: string | undefined,
    @CurrentUser() u: JwtUserPayload,
  ) {
    const where: any = {};
    if (keyword) {
      where.name = { contains: keyword, mode: 'insensitive' };
    }
    return this.prisma.course.findMany({
      where,
      orderBy: { startTime: 'desc' },
      take: 100,
    });
  }
}
