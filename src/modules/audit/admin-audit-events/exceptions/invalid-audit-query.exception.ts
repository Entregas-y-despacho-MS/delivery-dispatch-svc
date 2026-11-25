import { BadRequestException } from '@nestjs/common';

/** The `from`/`to` range of an audit search is not usable (unparseable, empty, reversed or too wide). */
export class InvalidAuditRangeException extends BadRequestException {
    constructor(message: string) {
        super({ message, error: 'INVALID_AUDIT_RANGE' });
    }
}

/** The filtered result is larger than one export may hold; the caller must narrow the window or add filters. */
export class AuditExportLimitExceededException extends BadRequestException {
    constructor(format: string, maxRows: number) {
        super({
            message: `The export has more than ${maxRows} rows, the maximum for ${format.toUpperCase()}. Narrow the 'from'/'to' window or add filters and export again.`,
            error: 'AUDIT_EXPORT_LIMIT_EXCEEDED',
        });
    }
}

/** A combination of audit filters that makes no sense (e.g. `entityId` without `entityType`). */
export class InvalidAuditFilterException extends BadRequestException {
    constructor(message: string) {
        super({ message, error: 'INVALID_AUDIT_FILTER' });
    }
}
