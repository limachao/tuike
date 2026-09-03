import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import * as bcrypt from 'bcrypt';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** 列出所有用户（仅 SUPER_ADMIN） */
  @Get()
  @Roles('SUPER_ADMIN')
  @UseGuards(RolesGuard)
  listAll() {
    return this.users.listAll();
  }

  /** 列出活跃销售人员（主管/超管可用） */
  @Get('sales')
  @Roles('SUPERVISOR', 'SUPER_ADMIN')
  @UseGuards(RolesGuard)
  listSales() {
    return this.users.listActiveSales();
  }

  /** 创建新用户（仅 SUPER_ADMIN） */
  @Post()
  @Roles('SUPER_ADMIN')
  @UseGuards(RolesGuard)
  async create(
    @Body() body: { phone: string; name: string; password: string; role?: 'SALES' | 'SUPERVISOR' },
  ) {
    const exists = await this.users.findByPhone(body.phone);
    if (exists) {
      throw new HttpException('手机号已被使用', HttpStatus.CONFLICT);
    }
    const passwordHash = await bcrypt.hash(body.password || '123456', 10);
    return this.users.create({
      phone: body.phone,
      name: body.name,
      passwordHash,
      role: body.role || 'SALES',
    });
  }

  /** 修改用户（仅 SUPER_ADMIN） */
  @Patch(':id')
  @Roles('SUPER_ADMIN')
  @UseGuards(RolesGuard)
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; role?: 'SALES' | 'SUPERVISOR'; isActive?: boolean; password?: string },
  ) {
    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.role !== undefined) data.role = body.role;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.password !== undefined) data.passwordHash = await bcrypt.hash(body.password, 10);
    return this.users.update(Number(id), data);
  }

  /** 软删除用户（仅 SUPER_ADMIN） */
  @Delete(':id')
  @Roles('SUPER_ADMIN')
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string) {
    return this.users.update(Number(id), { isActive: false });
  }

  /** 绑定企微 userid（主管/超管） */
  @Patch(':id/bind-wecom')
  @Roles('SUPERVISOR', 'SUPER_ADMIN')
  @UseGuards(RolesGuard)
  bindWecom(
    @Param('id') id: string,
    @Body() body: { wecomUserId: string },
  ) {
    return this.users.bindWecomUser(Number(id), body.wecomUserId, true);
  }
}
