import { InternalServerErrorException } from '@nestjs/common';

export class OsrmRequestException extends InternalServerErrorException {
    constructor(cause?: string) {
        super({ message: 'OSRM routing request failed.', error: 'OSRM_REQUEST_FAILED', cause });
    }
}
