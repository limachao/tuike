import {
  Controller,
  Post,
  Get,
  UseGuards,
  Body,
  Query,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';

@Controller('identity')
@UseGuards(JwtAuthGuard)
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post('run-match')
  runMatch() {
    return this.identity.runFullMatch();
  }

  @Get('exceptions')
  listExceptions(@Query('taskId') taskId?: string) {
    return this.identity.listIdentityExceptionCustomers(
      taskId ? Number(taskId) : undefined,
    );
  }

  @Post('manual-link')
  manualLink(
    @Body() body: { customerId: number; uid?: string; thirdPartyStudentId?: string },
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.identity.manualLink({ ...body, operator: u.sub });
  }
}
