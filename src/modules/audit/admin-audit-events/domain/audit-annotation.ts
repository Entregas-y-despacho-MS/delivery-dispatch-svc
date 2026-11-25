import type { Request } from 'express';

/**
 * Values only the handler knows once it ran (the settings version a change produced, the value it replaced).
 * `AdminAuditService` copies them into the event metadata, after the same secret/personal-data filter that
 * applies to `bodyFields`, so a forbidden key is dropped and never stored.
 */
export type AuditAnnotatedRequest = Request & { auditMetadata?: Record<string, unknown> };

export function annotateAudit(request: Request, values: Record<string, unknown>): void {
    const target = request as AuditAnnotatedRequest;
    target.auditMetadata = { ...target.auditMetadata, ...values };
}
