import { RoleEnum } from '../../../../shared/enums/index.js';
import type { AdminAuditEventEntity } from '../entities/admin-audit-event.entity.js';
import { InvalidAuditFilterException, InvalidAuditRangeException } from '../exceptions/invalid-audit-query.exception.js';
import { ADMIN_AUDIT_CATALOG } from './admin-audit-catalog.js';

/** Widest `from`/`to` window one search may cover; wider investigations are split into several searches. */
export const AUDIT_QUERY_MAX_RANGE_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export const AUDIT_RESULTS = ['success', 'denied', 'failed'] as const;
export const AUDIT_ORDERS = ['asc', 'desc'] as const;
export type AuditOrder = (typeof AUDIT_ORDERS)[number];

export const AUDIT_ACTIONS: readonly string[] = Object.keys(ADMIN_AUDIT_CATALOG);
export const AUDIT_ENTITY_TYPES: readonly string[] = [...new Set(Object.values(ADMIN_AUDIT_CATALOG).map((definition) => definition.entityType))];

/** ISO 8601 date-time that carries its own offset (`Z` or `±hh:mm`): the search never guesses a time zone. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The window `[from, to)` of a search: `from` is included, `to` is not, so two consecutive windows never repeat or
 * skip an event. Rejects what cannot be parsed, an empty or reversed window and one wider than the maximum.
 */
export function resolveAuditRange(from: string, to: string): { from: Date; to: Date } {
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new InvalidAuditRangeException("The 'from' and 'to' parameters must be valid date-times.");
    }
    if (start.getTime() >= end.getTime()) {
        throw new InvalidAuditRangeException("The 'from' parameter must be before 'to'.");
    }
    if (end.getTime() - start.getTime() > AUDIT_QUERY_MAX_RANGE_DAYS * DAY_MS) {
        throw new InvalidAuditRangeException(`The range between 'from' and 'to' must not exceed ${AUDIT_QUERY_MAX_RANGE_DAYS} days.`);
    }
    return { from: start, to: end };
}

/** An entity id only means something next to its type (ids of different types can coincide). */
export function assertEntityFilter(entityType: string | undefined, entityId: string | undefined): void {
    if (entityId !== undefined && entityType === undefined) {
        throw new InvalidAuditFilterException("The 'entityId' parameter requires 'entityType'.");
    }
}

/** What a caller of the search gets for one event. */
export interface AuditEventView {
    eventId: string;
    occurredAt: Date;
    actorId: number | null;
    actorRole: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    result: string;
    statusCode: number | null;
    correlationId: string;
    /** Only for ROOT. */
    ip?: string | null;
    /** Only for ROOT. */
    metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Projection by role. The administrator sees who did what, on what and with which outcome; the client address and
 * the declared body fields are the detail that only the break-glass account (ROOT) may read.
 */
export function toAuditEventView(event: AdminAuditEventEntity, role: RoleEnum): AuditEventView {
    const view: AuditEventView = {
        eventId: event.id,
        occurredAt: event.occurredAt,
        actorId: event.actorUserId,
        actorRole: event.actorRole,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        result: event.result,
        statusCode: event.statusCode,
        correlationId: event.correlationId,
    };
    if (role === RoleEnum.ROOT) {
        view.ip = event.ipAddress;
        view.metadata = event.metadata;
    }
    return view;
}
