import { QueryFailedError } from 'typeorm';

// Postgres error code for unique_violation.
const UNIQUE_VIOLATION = '23505';

/**
 * True when Postgres rejected a write because of a unique index. Two concurrent requests can both
 * pass an "already exists?" pre-check; the index is the real guard, and this lets the service turn
 * its rejection into the same 409 as the pre-check instead of a 500.
 */
export function isUniqueViolation(err: unknown): boolean {
    return err instanceof QueryFailedError
        && (err.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;
}
