import { RoleEnum } from '../../../shared/enums/index.js';

/**
 * Password policy (RF-A25, ST-310.1): only the security administrator changes it. Every other setting reachable
 * through `PUT /settings/:key` (delivery window, maximum wait, planning, lockout...) stays with the coordinator, and
 * the alert thresholds belong to the supervisor through `PUT /settings/alert-thresholds`.
 */
export const PASSWORD_POLICY_KEYS = [
    'password_min_length',
    'password_expiration_days',
    'password_require_uppercase',
    'password_require_lowercase',
    'password_require_number',
    'password_require_symbol',
] as const;

/** Roles allowed to change a setting through `PUT /settings/:key`. ROOT is always allowed (break-glass account). */
export function rolesAllowedToWriteSetting(key: string): readonly RoleEnum[] {
    if ((PASSWORD_POLICY_KEYS as readonly string[]).includes(key)) return [RoleEnum.ADMIN];
    return [RoleEnum.COORDINATOR];
}

export function canWriteSetting(key: string, role: RoleEnum): boolean {
    return role === RoleEnum.ROOT || rolesAllowedToWriteSetting(key).includes(role);
}
