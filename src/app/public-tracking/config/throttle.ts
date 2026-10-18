// Limit of the public tracking page, per client IP and window. Stricter than the global default
// (THROTTLE_LIMIT, 100/min) because anyone on the internet can call these routes and the token is the only
// secret: it lets a person guess tokens or verification codes only as fast as this allows. Read at load time
// because decorators need the value when the class is defined.
export const PUBLIC_TRACKING_LIMIT  = Number(process.env.THROTTLE_PUBLIC_TRACKING_LIMIT ?? 20);
export const PUBLIC_TRACKING_TTL_MS = Number(process.env.THROTTLE_TTL_MS ?? 60_000);
