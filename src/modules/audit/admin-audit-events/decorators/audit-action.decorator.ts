import { SetMetadata } from '@nestjs/common';
import type { AuditActionName } from '../domain/admin-audit-catalog.js';
import { isForbiddenMetadataKey } from '../domain/admin-audit-event.js';

export const AUDIT_ACTION_KEY = 'adminAuditAction';

/**
 * Where the id of the affected entity comes from:
 * - `param` (default): the route param named by `entityIdParam`.
 * - `response`: the `id` of the object the handler returns (creations: the id does not exist before the call).
 *   A failed call has no response, so its event carries no entity id.
 * - `actor`: the authenticated user (actions a user performs on its own account, e.g. its password or 2FA).
 */
export type AuditEntityIdSource = 'param' | 'response' | 'actor';

export interface AuditActionOptions {
    /** Route param that identifies the affected entity (default `id`). `null`: the action has no entity id. */
    entityIdParam?: string | null;
    /** Source of the entity id (default `param`). `entityIdParam` only applies to `param`. */
    entityIdFrom?: AuditEntityIdSource;
    /**
     * Request body fields copied to `metadata` (allow-list). Secrets and personal data are refused when the
     * decorator is applied, so a wrong declaration fails at startup instead of leaking.
     */
    bodyFields?: readonly string[];
    /**
     * Fixed values the handler adds to `metadata` (which of the operations of an action ran: `{ step: 'enable' }`).
     * Declared in code, never from the request; the same key rules as `bodyFields` apply.
     */
    metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditActionMetadata extends AuditActionOptions {
    action: AuditActionName;
}

/**
 * Marks a handler as a sensitive administrative action of the catalog: every call that reaches it, or is denied
 * before it (401/403), leaves an `admin_audit_events` row with actor, role, entity, result and correlation.
 * With `@Res()` the handler must send the response before it returns, so the recorded status is the real one.
 */
export const AuditAction = (action: AuditActionName, options: AuditActionOptions = {}): MethodDecorator => {
    const forbidden = [...(options.bodyFields ?? []), ...Object.keys(options.metadata ?? {})].filter(isForbiddenMetadataKey);
    if (forbidden.length > 0) {
        throw new Error(`@AuditAction('${action}'): bodyFields and metadata cannot include secrets or personal data (${forbidden.join(', ')}).`);
    }
    return SetMetadata(AUDIT_ACTION_KEY, { action, ...options } satisfies AuditActionMetadata);
};
