import { SetMetadata } from '@nestjs/common';
import type { AuditActionName } from '../domain/admin-audit-catalog.js';
import { isForbiddenMetadataKey } from '../domain/admin-audit-event.js';

export const AUDIT_ACTION_KEY = 'adminAuditAction';

export interface AuditActionOptions {
    /** Route param that identifies the affected entity (default `id`). `null`: the action has no entity id. */
    entityIdParam?: string | null;
    /**
     * Request body fields copied to `metadata` (allow-list). Secrets and personal data are refused when the
     * decorator is applied, so a wrong declaration fails at startup instead of leaking.
     */
    bodyFields?: readonly string[];
}

export interface AuditActionMetadata extends AuditActionOptions {
    action: AuditActionName;
}

/**
 * Marks a handler as a sensitive administrative action of the catalog: every call that reaches it, or is denied
 * before it (401/403), leaves an `admin_audit_events` row with actor, role, entity, result and correlation.
 */
export const AuditAction = (action: AuditActionName, options: AuditActionOptions = {}): MethodDecorator => {
    const forbidden = (options.bodyFields ?? []).filter(isForbiddenMetadataKey);
    if (forbidden.length > 0) {
        throw new Error(`@AuditAction('${action}'): bodyFields cannot include secrets or personal data (${forbidden.join(', ')}).`);
    }
    return SetMetadata(AUDIT_ACTION_KEY, { action, ...options } satisfies AuditActionMetadata);
};
