import { UserStatusEnum } from '../../../../shared/enums/index.js';

/**
 * The status shown in the user list (RF-A28), derived from two stored columns:
 *   inactive — the account was deactivated by an admin (`active = false`). Wins over a lock:
 *              a deactivated account can't log in either way, "inactive" is the more useful label.
 *   locked   — active, but temporarily locked by failed login attempts (`locked_until` in the future).
 *   active   — everything else. An expired lock (`locked_until` in the past) no longer counts.
 */
export function computeUserStatus(
    active: boolean,
    lockedUntil: Date | null | undefined,
    now: Date = new Date(),
): UserStatusEnum {
    if (!active) return UserStatusEnum.INACTIVE;
    if (lockedUntil && lockedUntil > now) return UserStatusEnum.LOCKED;
    return UserStatusEnum.ACTIVE;
}
