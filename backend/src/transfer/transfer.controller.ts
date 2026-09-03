import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { TransferService } from './transfer.service';

/**
 * 中转页接口：公开接口，无 JWT 鉴权（用 visitToken + SMS）
 */
@Controller('transfer')
export class TransferController {
  constructor(private readonly transfer: TransferService) {}

  @Get('course/:feiceLiveRoomId')
  bootstrap(
    @Param('feiceLiveRoomId') feiceLiveRoomId: string,
    @Query('token') visitToken?: string,
  ) {
    return this.transfer.bootstrap(feiceLiveRoomId, visitToken);
  }

  @Post('send-sms')
  sendSms(@Body() body: { mobile: string }) {
    return this.transfer.sendSmsCode(body.mobile);
  }

  @Post('login')
  login(
    @Body()
    body: {
      method: 'sms';
      mobile: string;
      code: string;
      feiceLiveRoomId: string;
      messageRecipientId?: number;
    },
    @Req() req: any,
  ) {
    return this.transfer.verifyIdentity({
      ...body,
      userAgent: req?.headers?.['user-agent'],
      clientIp: req?.ip,
    });
  }

  @Post('course/:feiceLiveRoomId/enter')
  enter(
    @Param('feiceLiveRoomId') feiceLiveRoomId: string,
    @Body() body: { visitToken: string },
  ) {
    return this.transfer.enterCourse(feiceLiveRoomId, body.visitToken);
  }

  @Post('course/:feiceLiveRoomId/stop-reminder')
  stop(
    @Param('feiceLiveRoomId') feiceLiveRoomId: string,
    @Body() body: { visitToken: string },
  ) {
    return this.transfer.stopReminder(feiceLiveRoomId, body.visitToken);
  }
}
