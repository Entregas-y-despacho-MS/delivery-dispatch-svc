import { ConflictException } from '@nestjs/common';

// RF-A31, Escenario 3 — a level with dispatches in progress can't be deleted, only disabled.
export class ServiceLevelInUseException extends ConflictException {
    constructor() {
        super({
            message: 'This service level has active dispatches and cannot be deleted. Disable it instead (active: false) so it only applies to future orders.',
            error:   'SERVICE_LEVEL_IN_USE',
        });
    }
}
