// What Express should trust in `X-Forwarded-For` (`TRUST_PROXY`, ST-224.1). Behind a reverse proxy every client
// reaches the app from the proxy's address, so the per-IP limit of `/public/tracking/*` would block them all at once.
//
// Accepted values:
// - empty / unset / `false`: trust nothing (the address of the socket is the client). The default.
// - a whole number N: trust the N closest hops (`1` for a single proxy in front of the app).
// - a comma-separated list of addresses, CIDR ranges or Express names (`loopback`, `linklocal`, `uniquelocal`).
// `true` is rejected on purpose: it trusts every hop, so any client could forge its address with a header and walk
// around the limit.
const EXPRESS_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const ADDRESS = /^[0-9a-f:.]+(\/\d{1,3})?$/i;

export type TrustProxySetting = false | number | string[];

export function parseTrustProxy(value: string | undefined): TrustProxySetting {
    const text = (value ?? '').trim();
    if (text === '' || text.toLowerCase() === 'false') return false;

    if (/^\d+$/.test(text)) {
        const hops = Number(text);
        return hops > 0 ? hops : false;
    }

    const entries = text.split(',').map((entry) => entry.trim());
    const invalid = entries.filter((entry) => !(EXPRESS_NAMES.has(entry.toLowerCase()) || ADDRESS.test(entry)));
    if (invalid.length > 0) {
        throw new Error(
            `TRUST_PROXY is not valid (${invalid.join(', ')}): use a number of hops, or a comma-separated list of addresses, CIDR ranges, loopback, linklocal or uniquelocal. "true" is not accepted because it lets any client forge its IP.`,
        );
    }
    return entries;
}
