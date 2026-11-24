import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { MailerPort } from '../../../plugins/mailer/mailer.port.js';
import { comparePassword, hashPassword, hashToken } from '../../../shared/utils/crypto.util.js';
import {
    ACCESS_CODE_COOLDOWN_SECONDS, ACCESS_CODE_SEND_WINDOW_SECONDS, ACCESS_EVENT_CODE_SENT, ACCESS_EVENT_LOCKED, ACCESS_EVENT_VERIFIED,
    ACCESS_SESSION_FORMAT, ACCESS_VERIFY_WINDOW_SECONDS, MAX_ACCESS_CODE_SENDS, MAX_ACCESS_VERIFY_ATTEMPTS, MAX_ACCESS_VERIFY_PER_WINDOW,
    accessKey, accessSessionKey, isWellFormedTrackingCode, normalizeTrackingCode, trackingCodeFingerprint,
} from '../domain/tracking-access.js';
import { generateVerificationCode } from '../domain/verification-code.js';
import type { AccessCodeAcceptedDto, AccessSessionDto, PublicTrackingSessionViewDto } from '../dto/tracking-access.dto.js';
import {
    InvalidAccessCodeException, TrackingAccessRateLimitedException, TrackingSessionInvalidException, VerificationUnavailableException,
} from '../exceptions/index.js';
import { PublicTrackingService, RESCHEDULE_CODE_EXPIRY_KEY } from './public-tracking.service.js';

/** What the cache keeps of an issued code: its bcrypt hash and, for a real dispatch, whose it is. A decoy has `dispatchId: null`. */
interface StoredAccessCode {
    hash: string;
    dispatchId: number | null;
}

/** What the cache keeps of a session, under the SHA-256 of the session. */
interface StoredAccessSession {
    dispatchId: number;
    expiresAt: number;
}

interface EligibleDispatch {
    dispatch_id: number;
    contact_email: string;
}

/**
 * Access to the tracking page with the tracking code plus a one-time code sent to the registered email (ST-309.1,
 * RF-U14, ES-309). It is the alternative to the link of ST-224.1 and it does not replace it.
 *
 * - The tracking code is NOT a credential: it only says whom the one-time code goes to. A session is the credential, an
 *   opaque random value of which only the SHA-256 is kept, limited to ONE dispatch (the id lives in the cache, the client
 *   never sends it).
 * - Nothing the caller can observe tells whether a tracking code exists. The answer of `requestCode` is the same, a code
 *   hash is stored and checked in the same way (for an unknown code a DECOY nobody can ever match), the counters are keyed
 *   by the fingerprint of the code, and the email is sent in the background so its latency does not tell either.
 * - The one-time code is not the delivery OTP: it has its own keys (`public-tracking:access:*`) and never touches
 *   `dispatch-otp`. It is stored as a bcrypt hash, is consumed once (`take`), and a wrong guess spends an attempt BEFORE it is
 *   compared. Neither the code, the session, the tracking code nor the email is written to a log or to an audit event.
 */
@Injectable()
export class TrackingAccessService {
    private readonly logger = new Logger(TrackingAccessService.name);
    /** Emails being sent in the background; tests wait for them with `whenIdle`. */
    private readonly inflight = new Set<Promise<void>>();

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly cache: CacheService,
        private readonly mailer: MailerPort,
        private readonly settings: SettingsService,
        private readonly tracking: PublicTrackingService,
    ) {}

    async requestCode(rawTrackingCode: string, now: Date = new Date()): Promise<AccessCodeAcceptedDto> {
        const normalized = normalizeTrackingCode(rawTrackingCode);
        const fingerprint = trackingCodeFingerprint(normalized);
        const ttlSeconds = await this.ttlSeconds();

        const allowed = await this.cached(() => this.cache.setIfAbsent(accessKey('cooldown', fingerprint), '1', ACCESS_CODE_COOLDOWN_SECONDS));
        if (!allowed) return await this.limited();
        const sends = await this.cached(() => this.cache.increment(accessKey('sends', fingerprint), ACCESS_CODE_SEND_WINDOW_SECONDS));
        if (sends > MAX_ACCESS_CODE_SENDS) return await this.limited();

        const target = isWellFormedTrackingCode(normalized) ? await this.findEligible(normalized, now) : null;

        // The same work for a real and for an unknown code: a code, its hash and a stored record. For an unknown one nobody
        // receives the code, so the record is a decoy that can never be matched but is spent exactly like a real one.
        const code = generateVerificationCode();
        const record: StoredAccessCode = { hash: await hashPassword(code), dispatchId: target?.dispatch_id ?? null };
        await this.cached(async () => {
            await this.cache.setWithTtl(accessKey('code', fingerprint), JSON.stringify(record), ttlSeconds);
            await this.cache.delete(accessKey('attempts', fingerprint));
        });

        if (target) this.sendInBackground(target, code, ttlSeconds, fingerprint, record.hash, now);
        return { accepted: true, expiresInSeconds: ttlSeconds };
    }

    async verify(rawTrackingCode: string, code: string, now: Date = new Date()): Promise<AccessSessionDto> {
        const normalized = normalizeTrackingCode(rawTrackingCode);
        const fingerprint = trackingCodeFingerprint(normalized);
        const ttlSeconds = await this.ttlSeconds();

        // A cap on every try for this tracking code, whatever code is issued: asking for a new code never resets it.
        const verifies = await this.cached(() => this.cache.increment(accessKey('verifies', fingerprint), ACCESS_VERIFY_WINDOW_SECONDS));
        if (verifies > MAX_ACCESS_VERIFY_PER_WINDOW) return await this.limited();

        const attempts = await this.cached(() => this.cache.increment(accessKey('attempts', fingerprint), ttlSeconds));
        const stored = parseStored(await this.cached(() => this.cache.get(accessKey('code', fingerprint))));
        if (!stored) {
            // Nothing stored (a code whose email failed, an expired one): the same bcrypt work as with a record, so the time says nothing.
            await comparePassword(code, await decoyHash());
            throw new InvalidAccessCodeException();
        }
        if (attempts > MAX_ACCESS_VERIFY_ATTEMPTS) {
            await this.cached(() => this.cache.delete(accessKey('code', fingerprint)));
            // In the background, so a real code and a decoy answer in the same time.
            if (stored.dispatchId !== null) {
                this.audit(stored.dispatchId, ACCESS_EVENT_LOCKED, 'Too many wrong access codes; the code was burned', { maxAttempts: MAX_ACCESS_VERIFY_ATTEMPTS });
            }
            throw new InvalidAccessCodeException();
        }
        if (!(await comparePassword(code, stored.hash))) throw new InvalidAccessCodeException();

        // Of two parallel requests with the right code only one takes it; the other finds nothing.
        const taken = parseStored(await this.cached(() => this.cache.take(accessKey('code', fingerprint))));
        if (!taken) throw new InvalidAccessCodeException();
        if (taken.hash !== stored.hash) {
            // A new code replaced the one that was checked while this request ran: it was not verified, so it is given back.
            await this.cached(() => this.cache.setIfAbsent(accessKey('code', fingerprint), JSON.stringify(taken), ttlSeconds));
            throw new InvalidAccessCodeException();
        }
        if (taken.dispatchId === null) throw new InvalidAccessCodeException();

        const session = randomBytes(32).toString('hex');
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
        const record: StoredAccessSession = { dispatchId: taken.dispatchId, expiresAt: expiresAt.getTime() };
        await this.cached(async () => {
            await this.cache.setWithTtl(accessSessionKey(hashToken(session)), JSON.stringify(record), ttlSeconds);
            await this.cache.delete(accessKey('attempts', fingerprint));
        });
        // The session exists already: a failure of the audit trail must not turn into a 500 that hides it from the customer.
        await this.recordEvent(taken.dispatchId, ACCESS_EVENT_VERIFIED, 'Access code checked; session opened', {
            expiresAt: expiresAt.toISOString(),
        }).catch((error) => this.logger.error(`The audit event ${ACCESS_EVENT_VERIFIED} of dispatch ${taken.dispatchId} was not saved (${errorName(error)}).`));
        return { session, expiresAt };
    }

    /** The page of the dispatch the session was opened for; any bad session (missing, malformed, unknown, expired) is the same 401. */
    async view(session: string | undefined, now: Date = new Date()): Promise<PublicTrackingSessionViewDto> {
        if (!session || !ACCESS_SESSION_FORMAT.test(session)) throw new TrackingSessionInvalidException();
        const stored = parseSession(await this.cached(() => this.cache.get(accessSessionKey(hashToken(session)))));
        if (!stored || stored.expiresAt <= now.getTime()) throw new TrackingSessionInvalidException();
        return await this.tracking.sessionView(stored.dispatchId, now);
    }

    /** Resolves when every email started by `requestCode` has finished (for tests; the request never waits for them). */
    async whenIdle(): Promise<void> {
        await Promise.all(this.inflight);
    }

    /** The delivery of the dispatch, only when it can receive the code: a delivery with a registered email and a link that has not expired. */
    private async findEligible(trackingCode: string, now: Date): Promise<EligibleDispatch | null> {
        const [row]: EligibleDispatch[] = await this.dataSource.query(
            `SELECT d.dispatch_id, d.contact_email
               FROM dispatches d
               JOIN dispatch_types dt ON dt.dispatch_type_id = d.dispatch_type_id AND dt.name = 'delivery'
              WHERE d.tracking_code = $1
                AND d.contact_email IS NOT NULL AND btrim(d.contact_email) <> ''
                AND (d.tracking_token_expires_at IS NULL OR d.tracking_token_expires_at > $2)`,
            [trackingCode, now],
        );
        return row ?? null;
    }

    private sendInBackground(target: EligibleDispatch, code: string, ttlSeconds: number, fingerprint: string, hash: string, now: Date): void {
        const task = (async () => {
            try {
                const result = await this.mailer.send({
                    to: target.contact_email,
                    subject: 'Tu código para ver el seguimiento',
                    template: 'tracking-access-code',
                    context: { code, expiresInMinutes: Math.round(ttlSeconds / 60) },
                    metadata: { dispatchId: target.dispatch_id },
                });
                if (result.status !== 'sent') throw new Error(`not delivered (${result.status})`);
                await this.recordEvent(target.dispatch_id, ACCESS_EVENT_CODE_SENT, 'Access code sent to the registered email', {
                    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
                });
            } catch (error) {
                // A code nobody received must not stay valid. The customer is not told: the answer was already the generic one.
                // Only the kind of failure is logged: the message of a mail server may carry the address.
                this.logger.warn(`The access code of dispatch ${target.dispatch_id} was not sent (${errorName(error)}).`);
                // Only the code that was issued for THIS email: a newer one, asked for after the cooldown, is left alone.
                await this.cache.get(accessKey('code', fingerprint))
                    .then(async (stored) => {
                        if (parseStored(stored)?.hash === hash) await this.cache.delete(accessKey('code', fingerprint));
                    })
                    .catch(() => undefined);
            }
        })();
        this.track(task);
    }

    /** An audit event written without making the answer wait for it; a failure is logged and never reaches the customer. */
    private audit(dispatchId: number, eventType: string, reason: string, metadata: Record<string, unknown>): void {
        this.track(
            this.recordEvent(dispatchId, eventType, reason, metadata)
                .catch((error) => this.logger.error(`The audit event ${eventType} of dispatch ${dispatchId} was not saved (${errorName(error)}).`)),
        );
    }

    private track(task: Promise<void>): void {
        this.inflight.add(task);
        void task.finally(() => this.inflight.delete(task));
    }

    /** The limit was hit: the same answer for any code. Nothing that identifies the tracking code is logged. */
    private async limited(): Promise<never> {
        this.logger.warn('A tracking access limit was reached.');
        throw new TrackingAccessRateLimitedException();
    }

    private async ttlSeconds(): Promise<number> {
        return (await this.settings.getNumber(RESCHEDULE_CODE_EXPIRY_KEY, 10)) * 60;
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

/** A bcrypt hash of a random value nobody knows, computed once: what a check against "nothing stored" compares with. */
let decoyHashPromise: Promise<string> | undefined;
function decoyHash(): Promise<string> {
    decoyHashPromise ??= hashPassword(randomBytes(16).toString('hex'));
    return decoyHashPromise;
}

/** The class of an error, never its message: that of a mail server or a driver can carry an address or a value. */
function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown error';
}

function parseStored(stored: string | null): StoredAccessCode | null {
    if (stored === null) return null;
    try {
        const record = JSON.parse(stored) as Partial<StoredAccessCode>;
        return typeof record.hash === 'string' && (record.dispatchId === null || typeof record.dispatchId === 'number')
            ? { hash: record.hash, dispatchId: record.dispatchId }
            : null;
    } catch {
        return null;
    }
}

function parseSession(stored: string | null): StoredAccessSession | null {
    if (stored === null) return null;
    try {
        const record = JSON.parse(stored) as Partial<StoredAccessSession>;
        return typeof record.dispatchId === 'number' && typeof record.expiresAt === 'number'
            ? { dispatchId: record.dispatchId, expiresAt: record.expiresAt }
            : null;
    } catch {
        return null;
    }
}
