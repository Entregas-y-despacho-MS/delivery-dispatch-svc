/** Width of `customer_notifications.last_error`. */
export const LAST_ERROR_MAX_LENGTH = 200;

const EMAIL = /[^\s@<>"']+@[^\s@<>"']+/g;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// Tokens and keys: a long run of letters, digits, `_` or `-` (a tracking token, an API key, a base64 blob).
const LONG_TOKEN = /[A-Za-z0-9_-]{20,}/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * The error of a failed send as it may be stored and read by staff: the provider's own words, but with every
 * address, link and token taken out (the recipient, the tracking link and a provider key can all appear in an SMTP
 * or API error), on one line and cut to the column width. It never throws and never returns an empty string.
 */
export function sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : 'unknown error';
    const clean = raw
        .replace(CONTROL_CHARACTERS, ' ')
        .replace(EMAIL, '[email]')
        .replace(URL_LIKE, '[url]')
        .replace(LONG_TOKEN, '[redacted]')
        .replace(/\s+/g, ' ')
        .trim();
    return (clean || 'unknown error').slice(0, LAST_ERROR_MAX_LENGTH);
}
