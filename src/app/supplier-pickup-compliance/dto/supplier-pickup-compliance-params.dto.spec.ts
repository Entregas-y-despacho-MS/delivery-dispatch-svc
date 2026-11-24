import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SupplierPickupComplianceParamsDto } from './supplier-pickup-compliance-params.dto.js';

async function messagesOf(query: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(plainToInstance(SupplierPickupComplianceParamsDto, query));
    return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('SupplierPickupComplianceParamsDto', () => {
    const valid = { from: '2026-11-01', to: '2026-11-30' };

    it('accepts only the dates, and every optional filter', async () => {
        expect(await messagesOf(valid)).toEqual([]);
        expect(await messagesOf({ ...valid, supplierId: 'SUP-1', warehouseId: '2', zoneId: '3', status: 'INCIDENT', exceptionLimit: '10' })).toEqual([]);
    });

    it('requires `from` and `to`', async () => {
        expect(await messagesOf({ to: valid.to })).not.toEqual([]);
        expect(await messagesOf({ from: valid.from })).not.toEqual([]);
    });

    it('rejects a date that is not YYYY-MM-DD', async () => {
        expect(await messagesOf({ ...valid, to: '30-11-2026' })).toContain("The 'to' parameter must be a valid date in YYYY-MM-DD format.");
    });

    it('rejects ids out of range, an unknown status and a supplier id that is too long', async () => {
        expect(await messagesOf({ ...valid, warehouseId: '0' })).toContain("The 'warehouseId' parameter must be >= 1.");
        expect(await messagesOf({ ...valid, zoneId: '2147483648' })).not.toEqual([]);
        expect(await messagesOf({ ...valid, status: 'lost' })).not.toEqual([]);
        expect(await messagesOf({ ...valid, supplierId: 'x'.repeat(101) })).toContain("The 'supplierId' parameter must be at most 100 characters.");
    });

    it('limits the size of the exceptions list', async () => {
        expect(await messagesOf({ ...valid, exceptionLimit: '0' })).toContain("The 'exceptionLimit' parameter must be >= 1.");
        expect(await messagesOf({ ...valid, exceptionLimit: '101' })).toContain("The 'exceptionLimit' parameter must be <= 100.");
        expect(await messagesOf({ ...valid, exceptionLimit: 'x' })).toContain("The 'exceptionLimit' parameter must be an integer.");
    });
});
