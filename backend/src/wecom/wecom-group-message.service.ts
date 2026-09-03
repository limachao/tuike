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

  /** 查询并更新状态（成员执行情况 + 客户级结果） */
  async refreshTaskStatus(taskId: number) {
    const task = await this.prisma.wecomGroupMessageTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { recipients: true },
    });
    if (!task.wecomMsgid) return { ok: false, msg: '未提交企业微信' };

    // 成员执行状态
    let confirmedCount = 0;
    try {
      const status = await this.api.queryGroupMessageSendStatus(task.wecomMsgid);
      for (const d of status?.detail ?? []) {
        if (Number(d.status) >= 2) confirmedCount++; // 2=已发送 3=已失败
      }
    } catch (e) {
      this.logger.warn(`查询成员执行状态失败: ${(e as Error).message}`);
    }

    // 客户级发送结果
    let sentSuccess = 0;
    let sentFail = 0;
    const failMap = new Map<string, string>();
    try {
      let cursor: string | undefined;
      do {
        const r: any = await this.api.queryGroupMessageCustomerResult(
          task.wecomMsgid,
          500,
          cursor,
        );
        for (const item of r.sent_list ?? []) {
          if (item.status === 'success') sentSuccess++;
          else {
            sentFail++;
            failMap.set(item.external_userid, item.status);
          }
        }
        for (const f of r.fail_list ?? []) {
          sentFail++;
          failMap.set(f.external_userid, f.fail_reason ?? 'fail');
        }
        cursor = r.next_cursor;
      } while (cursor);
    } catch (e) {
      this.logger.warn(`查询客户级发送结果失败: ${(e as Error).message}`);
    }

    // 计算最终状态
    let status: GroupMessageStatus = task.status;
    if (confirmedCount > 0) {
      const totalTry = sentSuccess + sentFail;
      if (sentFail === 0 && totalTry === task.totalRecipients) {
        status = GroupMessageStatus.ALL_SUCCESS;
      } else if (sentSuccess > 0 && sentFail > 0) {
        status = GroupMessageStatus.PARTIAL_SUCCESS;
      } else if (sentSuccess === 0 && sentFail > 0) {
        status = GroupMessageStatus.FAILED;
      } else {
        status = GroupMessageStatus.EXECUTED;
      }
    }

    // 更新 recipient 级状态
    for (const rec of task.recipients) {
      const s = failMap.get(rec.externalUserid);
      if (s) {
        await this.prisma.wecomGroupMessageRecipient.update({
          where: { id: rec.id },
          data: { wecomSendStatus: s, customerReceived: false, wecomFailReason: s },
        });
      } else if (sentSuccess > 0) {
        // 没在 failList 就先标记为 received=true（保守）
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
