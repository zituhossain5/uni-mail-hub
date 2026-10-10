import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

@Injectable()
export class RedisThrottleStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis: Redis;
  constructor(url: string) { this.redis = new Redis(url, { maxRetriesPerRequest: 1 }); }
  async increment(key: string, ttl: number, limit: number, blockDuration: number) {
    const redisKey = 'umh:throttle:' + key;
    const result = await this.redis.eval(`local hits=redis.call('INCR',KEYS[1]); if hits==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; if hits>tonumber(ARGV[2]) then redis.call('PEXPIRE',KEYS[1],ARGV[3]) end; return {hits,redis.call('PTTL',KEYS[1])}`, 1, redisKey, ttl, limit, blockDuration || ttl) as [number, number];
    const [totalHits, remaining] = result;
    return { totalHits, timeToExpire: remaining, isBlocked: totalHits > limit, timeToBlockExpire: totalHits > limit ? remaining : 0 };
  }
  onModuleDestroy() { this.redis.disconnect(); }
}
