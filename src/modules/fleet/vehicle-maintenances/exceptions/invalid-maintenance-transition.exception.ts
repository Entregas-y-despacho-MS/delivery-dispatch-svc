import { ConflictException } from '@nestjs/common';

export class InvalidMaintenanceTransitionException extends ConflictException {
    constructor(from: string, to: string) {
        super({
            message: `A maintenance cannot go from ${from} to ${to}. Allowed: pending -> in_progress -> completed.`,
            error: 'INVALID_MAINTENANCE_TRANSITION',
        });
    }
}
