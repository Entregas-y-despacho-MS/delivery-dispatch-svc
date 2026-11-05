import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangeVehicleStatusDto } from './change-vehicle-status.dto.js';

async function errorsOf(input: object): Promise<string[]> {
    const dto = plainToInstance(ChangeVehicleStatusDto, input);
    const errors = await validate(dto);
    return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('ChangeVehicleStatusDto', () => {
    it.each(['active', 'maintenance', 'out_of_service'])('accepts status %s with a reason', async (status) => {
        expect(await errorsOf({ status, reason: 'Inspection requires this transition.' })).toEqual([]);
    });

    it('requires a supported status', async () => {
        expect(await errorsOf({ status: 'unknown', reason: 'Reason.' })).toContain('Status must be active, maintenance, or out_of_service.');
    });

    it.each([undefined, null, '', '   '])('requires a non-empty string reason (%s)', async (reason) => {
        expect(await errorsOf({ status: 'maintenance', reason })).toContain('Reason is required.');
    });

    it('rejects a non-string reason', async () => {
        expect(await errorsOf({ status: 'maintenance', reason: 42 })).toContain('Reason must be a string.');
    });
});
