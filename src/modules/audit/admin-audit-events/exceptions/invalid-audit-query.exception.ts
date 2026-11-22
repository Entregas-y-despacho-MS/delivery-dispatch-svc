import { BadRequestException } from '@nestjs/common';

/** The `from`/`to` range of an audit search is not usable (unparseable, empty, reversed or too wide). */
export class InvalidAuditRangeException extends BadRequestException {
    constructor(message: string) {
        super({ message, error: 'INVALID_AUDIT_RANGE' });
    }
}

/** A combination of audit filters that makes no sense (e.g. `entityId` without `entityType`). */
export class InvalidAuditFilterException extends BadRequestException {
    constructor(message: string) {
        super({ message, error: 'INVALID_AUDIT_FILTER' });
    }
}
