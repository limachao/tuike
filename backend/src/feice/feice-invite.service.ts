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
