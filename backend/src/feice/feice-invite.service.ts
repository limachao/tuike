import { Injectable } from '@nestjs/common';
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
    thirdPartyTraceId: string;
    nickname?: string;
    mobile?: string;
    entryType?: 'live' | 'replay';
  }) {
    return this.api.generateInviteUrl(params);
  }
}
