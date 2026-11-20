import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { normalizeCorrelationId } from '../domain/admin-audit-event.js';

export const CORRELATION_HEADER = 'X-Request-Id';

/**
 * Gives every request a correlation id: the client's `X-Request-Id` when it is well formed, a new UUID otherwise.
 * It is echoed in the response so the client (and the logs) can point at the exact request.
 */
export function correlationIdMiddleware(request: Request & { correlationId?: string }, response: Response, next: NextFunction): void {
    const correlationId = normalizeCorrelationId(request.header(CORRELATION_HEADER)) ?? randomUUID();
    request.correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);
    next();
}
