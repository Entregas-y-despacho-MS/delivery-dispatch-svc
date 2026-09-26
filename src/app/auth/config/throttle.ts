// Stricter rate limit for the endpoints that verify a secret of an already-logged-in user (current password,
// 2FA): with a stolen access token they would otherwise allow guessing it as fast as the global limit
// (THROTTLE_LIMIT, 100/min) permits. Read at load time because decorators need the value when the class is defined.
export const SENSITIVE_LIMIT  = Number(process.env.THROTTLE_SENSITIVE_LIMIT ?? 10);
export const SENSITIVE_TTL_MS = Number(process.env.THROTTLE_TTL_MS ?? 60_000);
