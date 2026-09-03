import { Injectable, Logger } from '@nestjs/common';
import { WecomApiService } from './wecom-api.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

/**
 * 企业微信同步服务：
 * 1. 同步销售成员（绑定 wecom_userid）
 * 2. 同步每个销售的客户列表 + 详情
 * 3. 生成内部 student_id / third_party_trace_id
 * 4. 处理客户归属关系（主跟进人 + 多对多）
 * 5. 写入同步日志
 */
@Injectable()
export class WecomSyncService {
  private readonly logger = new Logger(WecomSyncService.name);

  constructor(
    private readonly api: WecomApiService,
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  /** 同步成员（应用可见范围内开通了客户联系的销售） */
  async syncUsers(triggeredBy?: number) {
    const syncLog = await this.prisma.syncLog.create({
      data: { type: 'WECOM_USERS', triggeredBy, triggeredSource: 'manual' },
    });
    try {
      const followUsers = await this.api.listContactUsers();
      let updated = 0;
      for (const fu of followUsers) {
        // 按手机号匹配需要人工确认；这里按 wecom_userid 绑定。首期主管需先在后台录入销售手机号创建账号，
        // 再将 wecom_userid 绑定。这里提供自动创建（无手机号、isActive=false，待主管确认）
        const exist = await this.prisma.user.findFirst({
          where: { wecomUserId: fu.userid },
        });
        if (!exist) {
          await this.prisma.user.create({
            data: {
              // 先占位，无手机号无法登录。主管需在后台绑定销售手机号
              phone: `unbound_${fu.userid}_${Date.now()}`,
              passwordHash: '*',
              name: fu.name ?? fu.userid,
              role: 'SALES',
              wecomUserId: fu.userid,
              hasCustomerContact: true,
              isActive: false,
            },
          });
        } else if (!exist.hasCustomerContact) {
          await this.users.bindWecomUser(exist.id, fu.userid, true);
        }
        updated++;
      }
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { endedAt: new Date(), records: updated, success: true },
      });
      return { synced: updated };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  /** 同步指定销售名下的客户（名单+详情） */
  async syncCustomersForSales(salesId: number, triggeredBy?: number) {
    const sales = await this.users.findById(salesId);
    if (!sales?.wecomUserId) {
      throw new Error('该销售尚未绑定企业微信 userid');
    }
    const syncLog = await this.prisma.syncLog.create({
      data: {
        type: 'WECOM_CUSTOMERS',
        triggeredBy,
        triggeredSource: 'manual',
      },
    });
    let total = 0;
    try {
      const list = await this.api.listCustomerExternalIds(sales.wecomUserId);
      for (const item of list) {
        await this.upsertCustomer(item.external_userid, sales.id);
        total++;
      }
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { endedAt: new Date(), records: total, success: true },
      });
      return { salesId, synced: total };
    } catch (e: any) {
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { endedAt: new Date(), success: false, errorMsg: e?.message },
      });
      throw e;
    }
  }

  /** 同步全部销售名下客户 */
  async syncAllCustomers(triggeredBy?: number) {
    const salesList = await this.users.listActiveSales();
    const result: any = {};
    for (const s of salesList) {
      if (!s.wecomUserId) continue;
      const r = await this.syncCustomersForSales(s.id, triggeredBy);
      result[s.id] = r;
    }
    return result;
  }

  private async upsertCustomer(externalUserid: string, salesId: number) {
    // 查详情（Mock 模式可能为空）
    let detail: any = null;
    try {
      detail = await this.api.getCustomerDetail(externalUserid);
    } catch (e) {
      detail = null;
    }
    const contact = detail?.external_contact ?? {};
    const followInfo = Array.isArray(detail?.follow_user)
      ? detail.follow_user.find((f: any) => f.userid)
      : null;

    const nickname = contact.name ?? '未命名客户';
    const avatar = contact.avatar ?? null;
    const gender = contact.gender ?? 0;
    const tags = JSON.stringify(contact.external_profile?.external_attr ?? []);
    const remarkMobiles = followInfo?.remark_mobiles?.join(',') ?? null;
    // 脱敏存储手机号（SHA256 便于匹配飞策 mobile，不可逆）
    const mobileEncrypted = remarkMobiles
      ? crypto.createHash('sha256').update(remarkMobiles.split(',')[0]).digest('hex')
      : null;
    const addTime = followInfo?.add_time
      ? new Date(Number(followInfo.add_time) * 1000)
      : new Date();

    // upsert 客户
    let customer = await this.prisma.customer.findUnique({
      where: { externalUserid },
    });
    if (!customer) {
      const studentId = `stu_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      const thirdPartyTraceId = `tpt_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
      customer = await this.prisma.customer.create({
        data: {
          externalUserid,
          nickname,
          avatar,
          gender,
          mobileEncrypted,
          remarkMobiles,
          tags,
          ownerUserId: salesId,
          studentId,
          thirdPartyTraceId,
          firstAddTime: addTime,
          lastSyncedAt: new Date(),
        },
      });
    } else {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          nickname,
          avatar,
          gender,
          remarkMobiles,
          mobileEncrypted: mobileEncrypted ?? customer.mobileEncrypted,
          tags,
          lastSyncedAt: new Date(),
        },
      });
    }
    // 归属关系（多对多）
    await this.prisma.customerSalesRelation.upsert({
      where: {
        customerId_salesUserId: { customerId: customer.id, salesUserId: salesId },
      },
      create: {
        customerId: customer.id,
        salesUserId: salesId,
        addTime,
        isPrimary: customer.ownerUserId === salesId,
      },
      update: { status: 'active' },
    });
    return customer;
  }
}
