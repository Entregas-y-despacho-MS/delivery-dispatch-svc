/**
 * Shape of a tracking token (ST-224.1). Pure.
 *
 * Tokens are `randomUUID()` values today, but the check is looser on purpose (letters, digits and hyphens,
 * 8 to 100 characters, the size of the column) so a change of generator does not lock customers out. Anything
 * else cannot be a token and is answered exactly like an unknown one, without a database read.
 */
const TOKEN_FORMAT = /^[A-Za-z0-9-]{8,100}$/;

export function isWellFormedTrackingToken(token: string): boolean {
    return TOKEN_FORMAT.test(token);
}
