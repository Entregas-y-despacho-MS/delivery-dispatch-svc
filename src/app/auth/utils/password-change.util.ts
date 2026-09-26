const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * RF-A25, Escenario 2 — true if an admin flagged the account (requiresPwdChange) OR the password is
 * older than `password_expiration_days`. Used both to tell the client at login (`mustChangePassword`)
 * and to enforce it on every request (PasswordChangeGuard).
 */
export function isPasswordChangeRequired(
    user: { requiresPwdChange: boolean; passwordChangedAt: Date },
    expirationDays: number,
    now: number = Date.now(),
): boolean {
    if (user.requiresPwdChange) return true;
    return now - user.passwordChangedAt.getTime() > expirationDays * DAY_MS;
}
