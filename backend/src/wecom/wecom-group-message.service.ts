import { Injectable, Logger } from '@nestjs/common';
import { WecomApiService } from './wecom-api.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { GroupMessageStatus } from '@prisma/client';

/**
 * 企业微信群发提醒任务服务：
 * - 创建任务
 * - 轮询状态更新
 * - 停止任务
 */
@Injectable()
export class WecomGroupMessageService {
  private readonly logger = new Logger(WecomGroupMessageService.name);
  constructor(
    private readonly api: WecomApiService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 快捷群发专用：直接调企微 API 创建任务并返回 msgid。
   * 不写数据库，由调用方自己写（避免嵌套事务 + 大列表锁表）。
   */
  async submitToWecomDraft(
    salesId: number,
    textContent: string,
    linkUrl: string,
    externalUserIds: string[],
    linkTitle = '点击进入',
  ): Promise<{ msgid: string; failList?: string[] }> {
    const sales = await this.prisma.user.findUniqueOrThrow({
      where: { id: salesId },
    });
    if (!sales.wecomUserId) {
      throw new Error('销售未绑定企业微信 userid');
    }
    if (externalUserIds.length === 0) throw new Error('名单为空');
    if (externalUserIds.length > 10000) {
      throw new Error('企业微信单次群发最多支持 10000 位客户');
    }
    return this.api.createGroupMessageTask({
      senderWecomUserId: sales.wecomUserId,
      externalUserIds,
      textContent,
      linkUrl,
      linkTitle,
    });
  }

  /**
   * 调用企业微信接口创建群发任务，并写入 msgid
   */
  async submitToWecom(taskId: number) {
    const task = await this.prisma.wecomGroupMessageTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        recipients: {
          include: { customer: true },
        },
        createdBy: true,
      },
    });
    if (!task.createdBy.wecomUserId) {
      throw new Error('销售未绑定企业微信 userid');
    }
    const externalIds = task.recipients
      .map((r) => r.customer.externalUserid)
      .filter(Boolean);
    if (externalIds.length === 0) {
      throw new Error('名单为空');
    }
    // 预检：每次最多 10000 人
    if (externalIds.length > 10000) {
      throw new Error('企业微信单次群发最多支持 10000 位客户');
    }
    const { msgid, failList } = await this.api.createGroupMessageTask({
      senderWecomUserId: task.createdBy.wecomUserId,
      externalUserIds: externalIds,
      textContent: task.finalContent,
      linkUrl: task.finalUrl,
      linkTitle: task.entryType === 'live' ? '直播入口' : '回放入口',
    });
    await this.prisma.wecomGroupMessageTask.update({
      where: { id: taskId },
      data: {
        wecomMsgid: msgid,
        status: GroupMessageStatus.PENDING_CONFIRM,
        wecomCreatedAt: new Date(),
        failList: failList ? JSON.stringify(failList) : undefined,
        sentFailCount: failList?.length ?? 0,
      },
    });
    return { msgid, failList };
  }

  /**
   * 查询并更新状态（成员执行情况 + 客户级结果）
   *
   * 正确流程：
   *   1. get_groupmsg_task(msgid) → 成员任务列表 task_list
   *      status: 0=未发送 2=已发送
   *   2. 对每个已发送成员逐个调 get_groupmsg_send_result(msgid, userid)
   *      返回 send_list, status: 0=未发送 1=已发送 2=非好友 3=超限
   *   3. 汇总所有 send_list
   */
  async refreshTaskStatus(taskId: number) {
    const task = await this.prisma.wecomGroupMessageTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { recipients: true, createdBy: true },
    });
    if (!task.wecomMsgid) return { ok: false, msg: '未提交企业微信' };

    // === 1. 获取成员发送任务列表 ===
    let memberTasks: Array<{ userid: string; status: number }> = [];
    let confirmedCount = 0;
    try {
      const r: any = await this.api.queryGroupMessageSendStatus(task.wecomMsgid);
      memberTasks = r?.task_list ?? [];
      // task_list 里 status >= 2 表示已发送
      confirmedCount = memberTasks.filter((m) => Number(m.status) >= 2).length;
      this.logger.log(
        `[refreshTaskStatus] msgid=${task.wecomMsgid} 成员任务数=${memberTasks.length} 已确认=${confirmedCount}`,
      );
    } catch (e) {
      this.logger.warn(`查询成员执行状态失败: ${(e as Error).message}`);
    }

    // === 2. 逐个成员查询客户级发送结果 ===
    // 企微 get_groupmsg_send_result **必须传 userid**，且只返回该成员的发送记录
    let sentSuccess = 0;
    let sentFail = 0;
    const failMap = new Map<string, string>();

    for (const member of memberTasks) {
      let cursor: string | undefined;
      do {
        try {
          const r: any = await this.api.queryGroupMessageCustomerResult(
            task.wecomMsgid,
            member.userid,
            500,
            cursor,
          );
          for (const item of r?.send_list ?? []) {
            const status = Number(item.status);
            if (status === 1) {
              // 1 = 已发送成功
              sentSuccess++;
            } else if (status === 2) {
              // 2 = 因客户不是好友导致发送失败
              sentFail++;
              failMap.set(item.external_userid, '客户非好友');
            } else if (status === 3) {
              // 3 = 因客户已收到其他群发消息导致发送失败（超限）
              sentFail++;
              failMap.set(item.external_userid, '客户本月群发超限');
            }
            // status === 0 未发送 不计入
          }
          cursor = r?.next_cursor;
        } catch (e) {
          this.logger.warn(
            `查询成员 ${member.userid} 客户级结果失败: ${(e as Error).message}`,
          );
          cursor = undefined; // 跳出循环避免无限重试
        }
      } while (cursor);
    }

    // === 3. 计算最终状态 ===
    let status: GroupMessageStatus = task.status;
    if (confirmedCount > 0) {
      const totalTry = sentSuccess + sentFail;
      if (sentFail === 0 && totalTry >= task.totalRecipients) {
        status = GroupMessageStatus.ALL_SUCCESS;
      } else if (sentSuccess > 0 && sentFail > 0) {
        status = GroupMessageStatus.PARTIAL_SUCCESS;
      } else if (sentSuccess === 0 && sentFail > 0) {
        status = GroupMessageStatus.FAILED;
      } else {
        status = GroupMessageStatus.EXECUTED;
      }
    }

    // === 4. 更新 recipient 级状态 ===
    for (const rec of task.recipients) {
      const failReason = failMap.get(rec.externalUserid);
      if (failReason) {
        await this.prisma.wecomGroupMessageRecipient.update({
          where: { id: rec.id },
          data: {
            wecomSendStatus: 'fail',
            customerReceived: false,
            wecomFailReason: failReason,
          },
        });
      } else if (sentSuccess > 0 && !failReason) {
        // 不在 failMap 里 + 有成功记录 → 保守标记为已发送
        await this.prisma.wecomGroupMessageRecipient.update({
          where: { id: rec.id },
          data: {
            wecomSendStatus: 'success',
            customerReceived: true,
          },
        });
      }
    }

    await this.prisma.wecomGroupMessageTask.update({
      where: { id: taskId },
      data: {
        status,
        confirmedCount,
        sentSuccessCount: sentSuccess,
        sentFailCount: sentFail,
        lastStatusCheckAt: new Date(),
      },
    });
    return { ok: true, status, sentSuccess, sentFail, confirmedCount };
  }

  /** 停止未完成的群发任务（仅能停止整体，不能删单个人） */
  async cancelTask(taskId: number) {
    const task = await this.prisma.wecomGroupMessageTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    if (!task.wecomMsgid) {
      await this.prisma.wecomGroupMessageTask.update({
        where: { id: taskId },
        data: { status: GroupMessageStatus.STOPPED },
      });
      return { ok: true };
    }
    try {
      await this.api.cancelGroupMessage(task.wecomMsgid);
    } catch (e) {
      this.logger.warn(`停止企业微信任务失败: ${(e as Error).message}`);
    }
    await this.prisma.wecomGroupMessageTask.update({
      where: { id: taskId },
      data: { status: GroupMessageStatus.STOPPED },
    });
    return { ok: true };
  }
}
