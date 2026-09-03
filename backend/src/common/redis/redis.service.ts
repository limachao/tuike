import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * 全局 Redis 单例，用于：
 * 1. 企业微信 access_token 缓存
 * 2. 飞策 access_token 缓存
 * 3. 限流 (提醒频率/群发重复拦截)
 * 4. BullMQ Queue 后端（在 sync/reminder 中单独实例化）
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(config: ConfigService) {
    const host = config.get<string>('REDIS_HOST', 'localhost');
    const port = config.get<number>('REDIS_PORT', 6379);
    const password = config.get<string>('REDIS_PASSWORD') || undefined;
    this.client = new Redis({
      host,
      port,
      password: password || undefined,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 5) {
          this.logger.error(`Redis 重连失败已达${times}次，停止重连`);
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    });
    this.client.connect().catch((e) => {
      this.logger.warn(`Redis 连接失败（开发环境可忽略）: ${e.message}`);
    });
  }

  get(): Redis {
    return this.client;
  }

  async safeGet(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (e) {
      return null;
    }
  }

  async safeSet(key: string, value: string, ttlSec?: number): Promise<boolean> {
    try {
      if (ttlSec) await this.client.set(key, value, 'EX', ttlSec);
      else await this.client.set(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 分布式锁: 成功返回 true, 已被占用返回 false
   */
  async tryLock(key: string, ttlSec = 30): Promise<boolean> {
    const result = await this.safeSet(
      `lock:${key}`,
      String(Date.now()),
      ttlSec,
    );
    // SET with NX via ioredis: we use SET key value EX ttl NX
    try {
      const r = await this.client.set(
        `lock:${key}`,
        String(Date.now()),
        'EX',
        ttlSec,
        'NX',
      );
      return r === 'OK';
    } catch (e) {
      return result;
    }
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
