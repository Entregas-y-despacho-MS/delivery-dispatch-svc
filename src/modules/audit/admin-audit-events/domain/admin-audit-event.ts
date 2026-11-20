import { randomUUID } from 'node:crypto';
import { ADMIN_AUDIT_CATALOG, type AuditActionName } from './admin-audit-catalog.js';

export type AuditResult = 'success' | 'denied' | 'failed';

/** The audit event contract (RF-A35). It never carries secrets, tokens or personal data. */
export interface AdminAuditEvent {
    eventId: string;
    occurredAt: Date;
    /** `null` when the request had no authenticated actor (denied before authentication). */
    actorId: number | null;
    actorRole: string | null;
    action: AuditActionName;
    entityType: string;
    entityId: string | null;
    result: AuditResult;
    statusCode: number | null;
    correlationId: string;
    /** Client address resolved by Express: only trusts `X-Forwarded-For` from the proxies in `TRUST_PROXY`. */
    ip: string | null;
    metadata: Record<string, string | number | boolean | null>;
}

export interface AuditEventInput {
    action: AuditActionName;
    actor: { id: number; role: string } | null;
    entityId: string | number | null | undefined;
    result: AuditResult;
    statusCode: number | null;
    correlationId: string | null | undefined;
    ip: string | null | undefined;
    metadata?: Record<string, unknown>;
    now?: Date;
}

/**
 * Keys that are never stored, whatever an action declares (defense in depth over the allow-list): secrets, and
 * personal data of users and customers. A key is split into words (`newPassword` → new, password; `api_key` → api,
 * key) and compared word by word, so `bypass` or `footprint` are not mistaken for a password or an OTP. Catalog
 * codes (`zoneCode`, `reasonCode`) are business data and stay.
 */
const SECRET_WORDS = new Set([
    'password', 'passwd', 'pass', 'pwd', 'passphrase', 'pin', 'token', 'jwt', 'secret', 'signature', 'otp', 'totp',
    'authorization', 'cookie', 'hash', 'credential', 'credentials', 'apikey',
]);
const SECRET_PAIRS = new Set(['api key', 'access key', 'private key', 'secret key', 'client secret']);
/** A `code` that is a one-time or verification code, not a catalog code. */
const SECRET_CODE_PREFIXES = new Set(['totp', 'otp', 'verification', 'reset', 'auth', 'security', 'recovery', 'backup']);
const PERSONAL_WORDS = new Set(['email', 'mail', 'phone', 'mobile', 'address', 'contact', 'recipient', 'document']);
const PERSONAL_PAIRS = new Set(['full name', 'first name', 'last name', 'user name']);
const MAX_METADATA_VALUE = 200;

const keyWords = (key: string): string[] =>
    key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());

export function isForbiddenMetadataKey(key: string): boolean {
    const words = keyWords(key);
    const pairs = words.slice(1).map((word, index) => `${words[index]} ${word}`);
    if (words.some((word) => SECRET_WORDS.has(word) || PERSONAL_WORDS.has(word))) return true;
    if (pairs.some((pair) => SECRET_PAIRS.has(pair) || PERSONAL_PAIRS.has(pair))) return true;
    if (words.length === 1 && (words[0] === 'code' || words[0] === 'name')) return true;
    const last = words.length - 1;
    return words[last] === 'code' && last > 0 && SECRET_CODE_PREFIXES.has(words[last - 1]!);
}

/** Keeps only scalar values of allowed keys, trimmed to a bounded length. */
export function redactMetadata(metadata: Record<string, unknown> | undefined): AdminAuditEvent['metadata'] {
    const clean: AdminAuditEvent['metadata'] = {};
    for (const [key, value] of Object.entries(metadata ?? {})) {
        if (isForbiddenMetadataKey(key)) continue;
        if (value === null || typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
        else if (typeof value === 'string') clean[key] = value.slice(0, MAX_METADATA_VALUE);
    }
    return clean;
}

/** `X-Request-Id` accepted from the client: short and without spaces or control characters. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export function normalizeCorrelationId(value: unknown): string | null {
    return typeof value === 'string' && CORRELATION_ID.test(value) ? value : null;
}

/** Express gives IPv4 clients as `::ffff:a.b.c.d`; it is stored as plain IPv4. */
export function normalizeIp(ip: string | null | undefined): string | null {
    if (!ip) return null;
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function buildAuditEvent(input: AuditEventInput): AdminAuditEvent {
    return {
        eventId: randomUUID(),
        occurredAt: input.now ?? new Date(),
        actorId: input.actor?.id ?? null,
        actorRole: input.actor?.role ?? null,
        action: input.action,
        entityType: ADMIN_AUDIT_CATALOG[input.action].entityType,
        entityId: input.entityId === null || input.entityId === undefined || input.entityId === '' ? null : String(input.entityId).slice(0, 64),
        result: input.result,
        statusCode: input.statusCode,
        correlationId: normalizeCorrelationId(input.correlationId) ?? randomUUID(),
        ip: normalizeIp(input.ip),
        metadata: redactMetadata(input.metadata),
    };
}

/**
 * The result of a request that reached (or tried to reach) a sensitive handler, from its HTTP status. Every 401/403
 * is `denied`: the guards' (no token, wrong role, password change pending) and the handler's own authorization
 * rules (e.g. changing one's own role, touching a root account).
 */
export function resultForStatus(status: number): AuditResult {
    if (status === 401 || status === 403) return 'denied';
    return status >= 400 ? 'failed' : 'success';
}
