/**
 * Catalog of sensitive administrative actions (RF-A35). Only handlers decorated with `@AuditAction(<one of these>)`
 * produce an audit event; the action name and its entity type always come from here, never from the request.
 *
 * `endpoints` lists, one by one, the handlers that carry each action as `<METHOD> <route without the global prefix>`.
 * `test/admin-audit-coverage.e2e-spec.ts` walks the routes of the real application and fails when a listed endpoint is
 * not decorated with its action, or when a decorated handler is not listed here: this is the action → handler matrix.
 * Driver operational endpoints (status, incidents, evidences, GPS) and the public customer endpoints are out of
 * this catalog: their trace is the dispatch history (`dispatch_events`).
 */
export interface AuditActionDefinition {
    /** `admin_audit_events.entity_type` of the action. */
    entityType: string;
    description: string;
    /** Exact `<METHOD> <route>` of every handler decorated with the action. */
    endpoints: readonly string[];
}

export const ADMIN_AUDIT_CATALOG = {
    // Users and access
    'user.created':           { entityType: 'user', description: 'Create an internal user account', endpoints: ['POST /users', 'POST /auth/register'] },
    'user.updated':           { entityType: 'user', description: 'Edit a user (data, activation, password reset by an admin)', endpoints: ['PUT /users/:id'] },
    'user.role_changed':      { entityType: 'user', description: 'Change the role of a user', endpoints: ['PATCH /users/:id/role'] },
    'user.deleted':           { entityType: 'user', description: 'Delete a user', endpoints: ['DELETE /users/:id'] },
    'auth.two_factor_changed': { entityType: 'user', description: 'Enable, confirm or disable two-factor authentication', endpoints: ['POST /auth/2fa/enable', 'POST /auth/2fa/confirm', 'POST /auth/2fa/disable'] },
    'auth.password_changed':  { entityType: 'user', description: 'Change one\'s own password', endpoints: ['PATCH /auth/change-password'] },

    // Business configuration
    'setting.updated':        { entityType: 'setting', description: 'Change a business setting or the alert thresholds', endpoints: ['PUT /settings/:key', 'PUT /settings/alert-thresholds'] },
    'catalog.changed':        {
        entityType: 'catalog',
        description: 'Create, edit or delete a catalog entry (zones, incident and reschedule reasons, service levels, vehicle incident types)',
        endpoints: [
            'POST /delivery-zones', 'PUT /delivery-zones/:id', 'DELETE /delivery-zones/:id',
            'POST /incident-reasons', 'PUT /incident-reasons/:id',
            'POST /reschedule-reasons', 'PUT /reschedule-reasons/:id',
            'POST /service-levels', 'PUT /service-levels/:id', 'DELETE /service-levels/:id',
            'POST /vehicle-incident-types', 'PUT /vehicle-incident-types/:id',
        ],
    },

    // Fleet
    'vehicle.changed':        { entityType: 'vehicle', description: 'Create, edit, delete a vehicle or change its status', endpoints: ['POST /vehicles', 'PUT /vehicles/:id', 'PATCH /vehicles/:id/status', 'DELETE /vehicles/:id'] },

    // Customer credential
    'tracking_link.revealed': { entityType: 'dispatch', description: 'Reveal a customer\'s tracking link (the customer\'s credential)', endpoints: ['POST /dispatches/change-requests/:id/tracking-link'] },

    // The audit trail itself
    'audit.exported':         { entityType: 'audit', description: 'Export the administrative audit trail as CSV or PDF', endpoints: ['GET /audit/admin-events/export'] },

    // Planning and route control
    'planning.run':           { entityType: 'planning', description: 'Generate a plan or run the cutoff', endpoints: ['POST /planning/generate', 'POST /planning/cutoff'] },
    'route_batch.approved':   { entityType: 'route_batch', description: 'Approve the promises or the final plan of a batch', endpoints: ['POST /route-batches/:id/approve-promises', 'POST /route-batches/:id/approve-final'] },
    'route_batch.assignment_changed': { entityType: 'route_batch', description: 'Change the driver, vehicle or reviewer of a batch, or reassign stops between batches', endpoints: ['PATCH /route-batches/:id/driver', 'PATCH /route-batches/:id/vehicle', 'PATCH /route-batches/:id/reviewer', 'POST /route-batches/:id/reassign'] },

    // Dispatch decisions of the coordinator
    'dispatch.cancelled':     { entityType: 'dispatch', description: 'Cancel a delivery or a pickup', endpoints: ['POST /dispatches/:id/cancel', 'PATCH /pickup-orders/:id/cancel'] },
    'dispatch.rescheduled':   { entityType: 'dispatch', description: 'Reschedule or return a dispatch, or change its priority', endpoints: ['POST /dispatches/:id/reschedule', 'POST /dispatches/:id/return', 'PATCH /dispatches/:id/priority'] },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditActionName = keyof typeof ADMIN_AUDIT_CATALOG;
