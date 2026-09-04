import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { CoursesService } from './courses.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  // ============= 监控任务 =============
  @Get('tasks')
  listMyTasks(@CurrentUser() u: JwtUserPayload) {
    return this.courses.listMyTasks(u.sub, u.role);
  }

  @Post('tasks')
  createTask(
    @Body()
    body: {
      courseId: number;
      taskName?: string;
      completeDurationPercent?: number;
      completeProgressPercent?: number;
      maxRemindersPerStudent?: number;
      createdBySalesId?: number; // 主管/超管可替销售创建任务
    },
    @CurrentUser() u: JwtUserPayload,
  ) {
    const isAdmin = u.role === 'SUPERVISOR' || u.role === 'SUPER_ADMIN';
    return this.courses.createTask({
      ...body,
      salesUserId: isAdmin && body.createdBySalesId ? body.createdBySalesId : u.sub,
    });
  }

  @Post('tasks/:taskId/delete')
  deleteTask(
    @Param('taskId') taskId: string,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.courses.deleteTask(Number(taskId), u.sub, u.role);
  }

  // ============= 应听名单 =============
  @Get('my-customers')
  listMyCustomers(
    @CurrentUser() u: JwtUserPayload,
    @Query('keyword') keyword?: string,
  ) {
    return this.courses.listCustomers(u.sub, u.role, keyword);
  }

  @Post('tasks/:taskId/select-all')
  selectAll(@Param('taskId') taskId: string, @CurrentUser() u: JwtUserPayload) {
    return this.courses.selectAllCustomersToTask(Number(taskId), u.sub, u.role);
  }

  @Post('tasks/:taskId/add-customer')
  addCustomer(
    @Param('taskId') taskId: string,
    @Body() body: { customerId: number },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.courses.addCustomerToTask({
      taskId: Number(taskId),
      customerId: body.customerId,
      salesUserId: u.sub,
      viewerRole: u.role,
    });
  }

  @Post('tasks/:taskId/exclude')
  exclude(
    @Param('taskId') taskId: string,
    @Body() body: { customerIds: number[]; reason?: string },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.courses.excludeFromTask({
      taskId: Number(taskId),
      customerIds: body.customerIds,
      reason: body.reason,
      operatorId: u.sub,
      operatorRole: u.role,
    });
  }

  @Post('tasks/:taskId/finalize')
  finalize(@Param('taskId') taskId: string, @CurrentUser() u: JwtUserPayload) {
    return this.courses.finalizeRoster(Number(taskId), u.sub, u.role);
  }

  @Get('tasks/:taskId/roster')
  listRoster(
    @Param('taskId') taskId: string,
    @Query()
    q: {
      status?: string;
      keyword?: string;
      page?: string;
      pageSize?: string;
    },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.courses.listRoster({
      taskId: Number(taskId),
      viewerUserId: u.sub,
      viewerRole: u.role,
      status: q.status,
      keyword: q.keyword,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  }
}
