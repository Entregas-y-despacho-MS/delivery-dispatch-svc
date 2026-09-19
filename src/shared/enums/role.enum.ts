// Must match roles.name exactly (delivery-dispatch-db/schema/auth/roles/data.sql).
// ROOT/ADMIN are system roles, not from the requirements doc — see DICTIONARY.md there.
// ROOT bypasses every @Roles() check (see RolesGuard) — the only hierarchical case.
// ADMIN/COORDINATOR/SUPERVISOR/DRIVER are parallel — none implies access to another's endpoints.
export enum RoleEnum {
    ROOT        = 'root',
    ADMIN       = 'admin',
    COORDINATOR = 'coordinator',
    SUPERVISOR  = 'supervisor',
    DRIVER      = 'driver',
}
