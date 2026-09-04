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
import {
  CurrentUser,
  JwtUserPayload,
} from '../common/decorators/current-user.decorator';
import * as bcrypt from 'bcrypt';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** 列出所有用户（主管/超管，用于用户管理） */
  @Get()
  @Roles('SUPERVISOR', 'SUPER_ADMIN')
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

  /** 创建新用户（主管/超管） */
  @Post()
  @Roles('SUPERVISOR', 'SUPER_ADMIN')
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

  /** 修改用户（主管/超管） */
  @Patch(':id')
  @Roles('SUPERVISOR', 'SUPER_ADMIN')
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

  /** 彻底删除销售账号及其全部相关数据（主管/超管） */
  @Delete(':id')
  @Roles('SUPERVISOR', 'SUPER_ADMIN')
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.users.deleteUser(Number(id), { sub: u.sub, role: u.role });
  }

  /** 绑定企微 userid（主管/超管；销售无权绑定） */
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
