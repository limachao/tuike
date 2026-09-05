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

  /** 同步指定销售名下的客户（批量分页拉取详情，7000+ 客户约几分钟） */
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
      let cursor: string | undefined;
      const seenExternalUserids = new Set<string>();
      do {
        const { list, nextCursor } = await this.api.getCustomersByUser(
          sales.wecomUserId,
          cursor,
        );
        for (const item of list) {
          const externalUserid = item?.external_contact?.external_userid;
          if (!externalUserid) continue;
          seenExternalUserids.add(externalUserid);
          await this.upsertCustomer(externalUserid, sales.id, item);
          total++;
        }
        cursor = nextCursor;
      } while (cursor);
      // 全量分页成功后，清理本次未返回的归属关系：
      // 客户已删除该销售/销售删除客户/离职继承后，企微接口不再返回，
      // 旧关系必须失效，否则客户会一直挂在已不跟进的销售名下。
      await this.pruneStaleRelations(sales.id, seenExternalUserids);
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

  /**
   * 写入/更新客户。detail 可直接传入批量接口返回的单条数据：
   * batch/get_by_user 条目为 { external_contact, follow_info }
   * externalcontact/get 返回为 { external_contact, follow_user: [] }
   * 不传 detail 时回退到逐个查详情（兼容旧调用）
   */
  private async upsertCustomer(externalUserid: string, salesId: number, detail?: any) {
    // 查详情（Mock 模式或未传入时可能为空）
    if (!detail) {
      try {
        detail = await this.api.getCustomerDetail(externalUserid);
      } catch (e) {
        detail = null;
      }
    }
    const contact = detail?.external_contact ?? {};
    // 两种返回结构兼容：follow_info（批量）或 follow_user[]（单个）
    const followInfo =
      detail?.follow_info ??
      (Array.isArray(detail?.follow_user)
        ? detail.follow_user.find((f: any) => f.userid)
        : null);

    const nickname = contact.name ?? '未命名客户';
    const avatar = contact.avatar ?? null;
    const gender = contact.gender ?? 0;
    const tags = JSON.stringify(contact.external_profile?.external_attr ?? []);
    const remarkMobiles = followInfo?.remark_mobiles?.join(',') ?? null;
    // unionid：企微后台绑定微信开发者ID后 externalcontact/get 才会返回
    const wecomUnionid = contact.unionid ?? null;
    // 脱敏存储手机号（SHA256 便于匹配飞策 mobile，不可逆）
    const mobileEncrypted = remarkMobiles
      ? crypto.createHash('sha256').update(remarkMobiles.split(',')[0]).digest('hex')
      : null;
    // 添加时间：企微 follow_info 标准字段是 createtime（Unix 秒），
    // 不存在 add_time 字段（历史 bug：取不到值时兜底 new Date()，导致所有
    // 客户的加入时间都变成同步当天）。取不到时保持 null，不伪造数据。
    const followTimeRaw = followInfo?.createtime ?? followInfo?.add_time;
    const addTime = followTimeRaw ? new Date(Number(followTimeRaw) * 1000) : null;

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
          wecomUnionid,
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
          wecomUnionid: wecomUnionid ?? undefined,
          tags,
          isDeleted: false, // 接口能返回说明好友关系仍在/已恢复
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
      update: { status: 'active', addTime: addTime ?? undefined },
    });
    return customer;
  }

  /**
   * 全量同步后清理失效归属：
   * 1. 该销售名下、本次接口未返回的客户关系 -> status=deleted
   * 2. 受影响客户若无任何 active 关系 -> 标记 isDeleted
   * 3. 若失效的是主归属销售(ownerUserId)，转交给仍有效的、最早添加的销售
   */
  private async pruneStaleRelations(salesId: number, seenExternalUserids: Set<string>) {
    const staleRelations = await this.prisma.customerSalesRelation.findMany({
      where: {
        salesUserId: salesId,
        status: 'active',
        customer: { externalUserid: { notIn: [...seenExternalUserids] } },
      },
      select: { id: true, customerId: true },
    });
    if (staleRelations.length === 0) return;
    const staleIds = staleRelations.map((r) => r.id);
    const affectedCustomerIds = [...new Set(staleRelations.map((r) => r.customerId))];

    await this.prisma.customerSalesRelation.updateMany({
      where: { id: { in: staleIds } },
      data: { status: 'deleted', isPrimary: false },
    });

    for (const customerId of affectedCustomerIds) {
      const activeRelations = await this.prisma.customerSalesRelation.findMany({
        where: { customerId, status: 'active' },
        orderBy: [{ addTime: 'asc' }, { id: 'asc' }],
      });
      if (activeRelations.length === 0) {
        // 所有销售都已无该客户好友关系
        await this.prisma.customer.update({
          where: { id: customerId },
          data: { isDeleted: true, unfollowReason: '同步确认：无任何有效跟进销售' },
        });
        continue;
      }
      // 主归属保持/转交给最早添加的有效销售
      const primary = activeRelations[0];
      await this.prisma.customerSalesRelation.updateMany({
        where: { customerId },
        data: { isPrimary: false },
      });
      await this.prisma.customerSalesRelation.update({
        where: { id: primary.id },
        data: { isPrimary: true },
      });
      await this.prisma.customer.update({
        where: { id: customerId },
        data: { ownerUserId: primary.salesUserId, isDeleted: false },
      });
    }
    this.logger.log(
      `销售#${salesId} 同步清理失效关系 ${staleRelations.length} 条，涉及客户 ${affectedCustomerIds.length} 位`,
    );
  }
}
