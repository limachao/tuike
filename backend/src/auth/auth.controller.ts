import { Controller, Post, Body, Get, UseGuards, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';
import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

class LoginDto {
  @IsPhoneNumber('CN', { message: '手机号格式不正确' })
  phone!: string;

  @IsString()
  @MinLength(6, { message: '密码至少6位' })
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() body: LoginDto, @Req() req: any) {
    const ip = req?.ip;
    const ua = req?.headers?.['user-agent'];
    return this.auth.login(body.phone, body.password, ip, ua);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtUserPayload) {
    return { ok: true, user };
  }
}
