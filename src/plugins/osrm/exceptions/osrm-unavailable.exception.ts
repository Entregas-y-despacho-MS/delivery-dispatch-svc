import { ServiceUnavailableException } from '@nestjs/common';

/** OSRM did not answer in time, could not be reached or answered 5xx. Nothing was computed. */
export class OsrmUnavailableException extends ServiceUnavailableException {
    constructor(timeoutMs?: number, cause?: string) {
        const seconds = timeoutMs ? ` within ${Math.round(timeoutMs / 1000)} s` : '';
        super({
            message: `The routing engine (OSRM) did not answer${seconds}. Try again in a few minutes.`,
            error: 'OSRM_UNAVAILABLE',
            cause,
        });
    }
}
