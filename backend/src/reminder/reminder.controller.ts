import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ReminderService } from './reminder.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';
import { MessageTemplateType, GroupMessageStatus } from '@prisma/client';

@Controller('reminder')
@UseGuards(JwtAuthGuard)
export class ReminderController {
  constructor(private readonly reminder: ReminderService) {}

  // ============ 模板 ============
  @Get('templates')
  listTemplates() {
    return this.reminder.listTemplates();
  }

  // ============ 预览 + 创建 ============
  @Post('preview')
  preview(
    @Body()
    body: {
      taskId: number;
      templateType: MessageTemplateType;
      customContent?: string;
      entryType?: 'live' | 'replay';
      rosterIds?: number[];
    },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.reminder.preview({ ...body, operatorId: u.sub });
  }

  @Post('create')
  create(
    @Body()
    body: {
      taskId: number;
      templateType: MessageTemplateType;
      customContent?: string;
      entryType?: 'live' | 'replay';
      rosterIds?: number[];
    },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.reminder.createAndSubmit({ ...body, operatorId: u.sub });
  }

  // ============ 快捷群发 ============
  @Post('quick-send')
  quickSend(
    @Body()
    body: {
      content: string;
      url: string;
      customerIds: number[];
      linkTitle?: string;
    },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.reminder.quickSend({ ...body, operatorId: u.sub });
  }

  // ============ 任务状态 ============
  @Get('message-tasks')
  listMyTasks(
    @CurrentUser() u: JwtUserPayload,
    @Query('status') status?: GroupMessageStatus,
  ) {
    return this.reminder.listMyMessageTasks(u.sub, status);
  }

  @Get('message-tasks/:id')
  detail(
    @Param('id') id: string,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.reminder.getMessageTaskDetail(Number(id), u.sub);
  }

  @Post('message-tasks/:id/refresh-status')
  refresh(@Param('id') id: string) {
    return this.reminder.refreshMessageTask(Number(id));
  }

  @Post('message-tasks/:id/stop')
  stop(
    @Param('id') id: string,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.reminder.stopMessageTask(Number(id), u.sub);
  }

  // ============ 单学生停止 ============
  @Post('task/:taskId/student/:customerId/stop')
  stopForStudent(
    @Param() params: { taskId: string; customerId: string },
    @Body('reason') reason: string | undefined,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.reminder.stopForStudent({
      taskId: Number(params.taskId),
      customerId: Number(params.customerId),
      operatorId: u.sub,
      reason,
    });
  }
}
