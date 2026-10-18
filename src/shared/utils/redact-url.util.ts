/**
 * Hides the tracking token of a public tracking URL (`/api/public/tracking/<token>/slots` → `…/:token/slots`).
 *
 * The token is the customer's only credential, so it must not reach a log line or the `path` echoed in an error
 * body (and from there a proxy log, a monitoring tool or the support screenshot of an error). Anything that
 * is not under `/public/tracking/` is returned as it came.
 */
const TRACKING_TOKEN_IN_URL = /(\/public\/tracking\/)[^/?#]+/;

export function redactTrackingToken(url: string): string {
    return url.replace(TRACKING_TOKEN_IN_URL, '$1:token');
}
