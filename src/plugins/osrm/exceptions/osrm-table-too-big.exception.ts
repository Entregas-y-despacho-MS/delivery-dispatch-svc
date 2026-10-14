import { InternalServerErrorException } from '@nestjs/common';

/**
 * OSRM answered `TooBig` to a `table` request: OSRM_TABLE_MAX_COORDINATES is above what the
 * instance accepts (`--max-table-size`). The adapter already splits requests, so this is a
 * misconfiguration; it is internal and the planner turns it into an `osrm_table_limit_exceeded` alert.
 */
export class OsrmTableTooBigException extends InternalServerErrorException {
    constructor(cause?: string) {
        super({ message: 'OSRM rejected the table request as too big.', error: 'OSRM_TABLE_TOO_BIG', cause });
    }
}
