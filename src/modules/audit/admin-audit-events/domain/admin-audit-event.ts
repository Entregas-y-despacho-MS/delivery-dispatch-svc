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
 * personal data of users and customers. Catalog codes (`zoneCode`, `reasonCode`) are business data and stay.
 */
const SECRET_KEY = /pass(word)?|token|secret|signature|otp|authorization|cookie|hash|^(totp|verification|reset)?code$/i;
const PERSONAL_KEY = /e-?mail|phone|full_?name|first_?name|last_?name|^name$|address|document|contact|recipient/i;
const MAX_METADATA_VALUE = 200;

export const isForbiddenMetadataKey = (key: string): boolean => SECRET_KEY.test(key) || PERSONAL_KEY.test(key);

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
