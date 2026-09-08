import { Injectable, BadRequestException } from '@nestjs/common';
import { FeiceApiService } from './feice-api.service';

/**
 * 邀课链接生成服务
 * 中转页登录成功后，调用此服务生成带 thirdPartyTraceId 的飞策入口 URL。
 */
@Injectable()
export class FeiceInviteService {
  constructor(private readonly api: FeiceApiService) {}

  async buildEntryUrl(params: {
    liveRoomId: string;
    thirdPartyTraceId?: string;
    userId?: string;
    mobile?: string;
  }) {
    return this.api.generateInviteUrl({
      liveRoomId: params.liveRoomId,
      thirdPartyTraceId: params.thirdPartyTraceId,
      userId: params.userId,
      mobile: params.mobile,
    });
  }

  /**
   * 直播间通用邀课链接（兜底）。
   *
   * 实测（2026-09-08）：invitation-link/list 的 userId 参数要的是飞策 SCRM 用户 id
   * （78/77 开头 19 位，如销售 inviteUserId），不是课堂记录里的直播 uid（85 开头）——
   * 传 85 开头 uid 一律报「用户不存在」；手机号路径又要求该手机号已在飞策建档。
   *
   * 因此学员级标识都走不通时，取该直播间邀课记录中销售的 SCRM id，生成该销售的
   * 专属邀课链接。学员在微信打开后走飞策自己的微信登录，听课记录按学员本人
   * unionId 归因（与销售私发链接的真实流程一致）。
   */
  async buildRoomSalesInviteUrl(liveRoomId: string) {
    const { list } = await this.api.listInviteRecords({ liveRoomId, offset: 0 });
    const salesId = list
      .map((r: any) => r?.inviteUserId)
      .find((id: any) => id && String(id).startsWith('7'));
    if (!salesId) {
      throw new Error('该直播间暂无销售邀课记录，无法生成课程入口');
    }
    return this.api.generateInviteUrl({
      liveRoomId,
      userId: String(salesId),
    });
  }

  /**
   * 内部员工（销售/主管）后台观看课程/回放
   * 用机构固定的内部飞策手机号生成链接（须在飞策系统中存在），
   * traceId 带 internal_ 前缀，与学员数据区分。
   */
  async buildInternalPlayUrl(params: { liveRoomId: string; userId: number }) {
    const mobile = (process.env.FEICE_INTERNAL_MOBILE || '').trim();
    if (!mobile) {
      throw new BadRequestException(
        '内部观看功能未配置：请在服务器 .env 设置 FEICE_INTERNAL_MOBILE（飞策系统中存在的手机号）',
      );
    }
    const thirdPartyTraceId = `internal_${params.userId}_${Date.now()}`.slice(0, 32);
    return this.api.generateInviteUrl({
      liveRoomId: params.liveRoomId,
      mobile,
      thirdPartyTraceId,
    });
  }
}
