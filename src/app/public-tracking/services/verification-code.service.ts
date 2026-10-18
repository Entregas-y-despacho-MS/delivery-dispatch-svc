import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { MailerPort } from '../../../plugins/mailer/mailer.port.js';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { comparePassword, hashPassword, hashToken, tokenMatchesHash } from '../../../shared/utils/crypto.util.js';
import {
    CODE_SEND_WINDOW_SECONDS, MAX_CODE_SENDS, MAX_VERIFY_ATTEMPTS, generateVerificationCode, maskEmail,
} from '../domain/verification-code.js';
import type { VerificationCodeSentDto, VerificationProofDto } from '../dto/verification.dto.js';
import {
    InvalidVerificationCodeException, VerificationCodeExpiredException,
    VerificationCodeNotSentException, VerificationCodeRateLimitedException, VerificationUnavailableException,
} from '../exceptions/index.js';
import { RESCHEDULE_CODE_EXPIRY_KEY, assertCanReschedule, type TrackingContext } from './public-tracking.service.js';

/** 32 random bytes in hex: what a proof looks like. Anything else cannot be one and is not even compared. */
const PROOF_FORMAT = /^[0-9a-f]{64}$/;

/**
 * The verification code of the customer's rescheduling and the proof that it was checked (ST-224.1, D-47).
 *
 * The customer asks for a code, receives it in the registered email, sends it back and gets a PROOF, which
 * is what later opens the offer of slots and the rescheduling itself. The code and the proof live in the cache
 * with a time to live equal to `reschedule_code_expiry_minutes`, so they expire on their own; the code is stored
 * as a bcrypt hash and the proof as a SHA-256 fingerprint, never in clear. A wrong guess spends one of
 * `MAX_VERIFY_ATTEMPTS` BEFORE the code is compared, so a burst of parallel guesses cannot exceed the limit.
 *
 * Neither the code, the proof nor the token is written to the audit trail or to a log: the events only say
 * that a code was sent, verified or burned.
 */
@Injectable()
export class VerificationCodeService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly cache: CacheService,
        private readonly mailer: MailerPort,
        private readonly settings: SettingsService,
    ) {}

    async send(context: TrackingContext, now: Date = new Date()): Promise<VerificationCodeSentDto> {
        assertCanReschedule(context);
        const email = context.row.contact_email!;
        const { dispatchId } = context;
        const ttlSeconds = await this.ttlSeconds();

        const sends = await this.cached(() => this.cache.increment(key('sends', dispatchId), CODE_SEND_WINDOW_SECONDS));
        if (sends > MAX_CODE_SENDS) throw new VerificationCodeRateLimitedException();

        const code = generateVerificationCode();
        await this.cached(async () => {
            await this.cache.setWithTtl(key('code', dispatchId), JSON.stringify({ hash: await hashPassword(code) }), ttlSeconds);
            // A new code starts with all its attempts.
            await this.cache.delete(key('attempts', dispatchId));
        });

        if (!(await this.deliver(email, code, ttlSeconds, dispatchId))) {
            await this.cached(() => this.cache.delete(key('code', dispatchId)));
            throw new VerificationCodeNotSentException();
        }

        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
        await this.recordEvent(dispatchId, 'reschedule_code_sent', 'Verification code sent to the registered email', {
            recipient: maskEmail(email), expiresAt: expiresAt.toISOString(),
        });
        return { sentTo: maskEmail(email), expiresAt };
    }

    async verify(context: TrackingContext, code: string, now: Date = new Date()): Promise<VerificationProofDto> {
        assertCanReschedule(context);
        const { dispatchId } = context;
        const ttlSeconds = await this.ttlSeconds();

        const attempts = await this.cached(() => this.cache.increment(key('attempts', dispatchId), ttlSeconds));
        const stored = await this.cached(() => this.cache.get(key('code', dispatchId)));
        if (!stored) throw new VerificationCodeExpiredException();
        if (attempts > MAX_VERIFY_ATTEMPTS) {
            await this.cached(() => this.cache.delete(key('code', dispatchId)));
            await this.recordEvent(dispatchId, 'reschedule_code_locked', 'Too many wrong verification codes; the code was burned', {
                maxAttempts: MAX_VERIFY_ATTEMPTS,
            });
            throw new VerificationCodeExpiredException();
        }

        const { hash } = JSON.parse(stored) as { hash: string };
        if (!(await comparePassword(code, hash))) {
            throw new InvalidVerificationCodeException(Math.max(0, MAX_VERIFY_ATTEMPTS - attempts));
        }

        // Of two parallel requests with the right code only one takes it; the other finds nothing.
        const taken = await this.cached(() => this.cache.take(key('code', dispatchId)));
        if (!taken) throw new VerificationCodeExpiredException();

        const proof = randomBytes(32).toString('hex');
        await this.cached(async () => {
            await this.cache.setWithTtl(key('proof', dispatchId), hashToken(proof), ttlSeconds);
            await this.cache.delete(key('attempts', dispatchId));
        });
        await this.recordEvent(dispatchId, 'reschedule_code_verified', 'Verification code checked', {});
        return { proof, expiresAt: new Date(now.getTime() + ttlSeconds * 1000) };
    }

    /** True when `proof` is the one issued to this dispatch and it has not expired. Does not consume it. */
    async hasValidProof(dispatchId: number, proof: string | undefined): Promise<boolean> {
        if (!proof || !PROOF_FORMAT.test(proof)) return false;
        const stored = await this.cached(() => this.cache.get(key('proof', dispatchId)));
        return stored !== null && tokenMatchesHash(proof, stored);
    }

    private async ttlSeconds(): Promise<number> {
        return (await this.settings.getNumber(RESCHEDULE_CODE_EXPIRY_KEY, 10)) * 60;
    }

    private async deliver(email: string, code: string, ttlSeconds: number, dispatchId: number): Promise<boolean> {
        try {
            const result = await this.mailer.send({
                to: email,
                subject: 'Tu código de verificación',
                template: 'reschedule-code',
                context: { code, expiresInMinutes: Math.round(ttlSeconds / 60) },
                metadata: { dispatchId },
            });
            return result.status === 'sent';
        } catch {
            return false;
        }
    }

    private async recordEvent(dispatchId: number, eventType: string, reason: string, metadata: Record<string, unknown>): Promise<void> {
        await this.dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             VALUES ($1, $2, 'customer', $3, $4::jsonb)`,
            [dispatchId, eventType, reason, JSON.stringify(metadata)],
        );
    }

    /** A cache that is down must not become a 500: the customer is told verification is temporarily unavailable. */
    private async cached<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (error instanceof CacheUnavailableException) throw new VerificationUnavailableException();
            throw error;
        }
    }
}

function key(kind: 'code' | 'attempts' | 'sends' | 'proof', dispatchId: number): string {
    return `public-tracking:${kind}:${dispatchId}`;
}
