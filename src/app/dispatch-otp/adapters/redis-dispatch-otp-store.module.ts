import { Module } from '@nestjs/common';
import { RedisCacheConfig } from '../../../plugins/cache/redis/redis-cache.config.js';
import { DispatchOtpStore } from '../ports/dispatch-otp-store.port.js';
import { RedisDispatchOtpStore } from './redis-dispatch-otp-store.adapter.js';

@Module({ providers: [RedisCacheConfig, RedisDispatchOtpStore, { provide: DispatchOtpStore, useExisting: RedisDispatchOtpStore }], exports: [DispatchOtpStore] })
export class RedisDispatchOtpStoreModule {}
