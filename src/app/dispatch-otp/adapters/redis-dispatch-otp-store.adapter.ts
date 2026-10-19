import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import { RedisCacheConfig } from '../../../plugins/cache/redis/redis-cache.config.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { DispatchOtpStore, type OtpIssueResult, type OtpVerifyResult } from '../ports/dispatch-otp-store.port.js';

// Both keys use one Redis Cluster slot. Metadata deliberately outlives the code: expiry must not reset limits.
const ISSUE = `
local exists=redis.call('EXISTS',KEYS[1])
if ARGV[3]=='0' and exists==1 then return 'already_issued' end
if ARGV[3]=='1' and exists==0 then return 'not_issued' end
if redis.call('HGET',KEYS[1],'consumed')=='1' then return 'consumed' end
if tonumber(redis.call('HGET',KEYS[1],'failures') or '0')>=3 then return 'locked' end
if ARGV[3]=='1' then
 if tonumber(redis.call('HGET',KEYS[1],'resends') or '0')>=2 then return 'resend_limit' end
 redis.call('HINCRBY',KEYS[1],'resends',1)
else
 redis.call('HSET',KEYS[1],'failures',0,'resends',0,'consumed',0)
end
redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2])
return 'issued'`;

const VERIFY = `
if redis.call('HGET',KEYS[1],'consumed')=='1' then return 'consumed' end
if tonumber(redis.call('HGET',KEYS[1],'failures') or '0')>=3 then return 'locked' end
local hash=redis.call('GET',KEYS[2])
if not hash then return 'expired' end
if hash~=ARGV[1] then return 'replaced' end
if ARGV[2]=='1' then
 redis.call('HSET',KEYS[1],'consumed',1,'evidence_id',ARGV[3])
 redis.call('DEL',KEYS[2])
 return 'verified'
end
local failures=redis.call('HINCRBY',KEYS[1],'failures',1)
if failures>=3 then redis.call('DEL',KEYS[2]); return 'locked' end
return 'invalid'`;

@Injectable()
export class RedisDispatchOtpStore extends DispatchOtpStore implements OnModuleInit, OnModuleDestroy {
    private readonly client: RedisClientType;
    private readonly logger = new Logger(RedisDispatchOtpStore.name);

    constructor(config: RedisCacheConfig) {
        super();
        this.client = createClient({ socket: { host: config.host, port: config.port, connectTimeout: 1500,
            reconnectStrategy: (retries) => Math.min(250 * 2 ** Math.min(retries, 4), 4000) } });
        this.client.on('error', () => this.logger.warn('OTP Redis unavailable.'));
    }

    async onModuleInit(): Promise<void> {
        void this.client.connect().catch(() => this.logger.warn('OTP Redis unavailable.'));
    }

    async onModuleDestroy(): Promise<void> {
        if (!this.client.isOpen) return;
        if (!this.client.isReady) { this.client.destroy(); return; }
        await this.client.quit().catch(() => this.client.destroy());
    }

    async issue(dispatchId: number, hash: string, ttlSeconds: number, resend = false): Promise<OtpIssueResult> {
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new RangeError('Invalid OTP TTL.');
        return await this.guard(async () => await this.client.eval(ISSUE, {
            keys: keys(dispatchId), arguments: [hash, String(ttlSeconds), resend ? '1' : '0'],
        }) as OtpIssueResult);
    }

    async invalidate(dispatchId: number, expectedHash: string): Promise<void> {
        await this.guard(async () => { await this.client.eval(
            "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]) end; return 1",
            { keys: [keys(dispatchId)[1]], arguments: [expectedHash] },
        ); });
    }

    async readHash(dispatchId: number): Promise<string | null> {
        return await this.guard(async () => await this.client.get(keys(dispatchId)[1]));
    }

    async verify(dispatchId: number, expectedHash: string, matches: boolean, evidenceId = ''): Promise<OtpVerifyResult> {
        return await this.guard(async () => await this.client.eval(VERIFY, {
            keys: keys(dispatchId), arguments: [expectedHash, matches ? '1' : '0', evidenceId],
        }) as OtpVerifyResult);
    }

    async readVerifiedEvidenceId(dispatchId: number): Promise<string | null> {
        const value = await this.guard(async () => await this.client.hGet(keys(dispatchId)[0], 'evidence_id'));
        return value ? value : null;
    }

    private async guard<T>(operation: () => Promise<T>): Promise<T> {
        if (!this.client.isReady) throw new CacheUnavailableException();
        try { return await operation(); } catch { throw new CacheUnavailableException(); }
    }
}

function keys(dispatchId: number): [string, string] {
    if (!Number.isSafeInteger(dispatchId) || dispatchId <= 0) throw new RangeError('Invalid dispatch id.');
    return [`dispatch-otp:{${dispatchId}}:limits`, `dispatch-otp:{${dispatchId}}:code`];
}
