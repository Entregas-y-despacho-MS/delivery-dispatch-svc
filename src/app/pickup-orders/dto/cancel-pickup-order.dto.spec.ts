// ST-81.2 — validation of the body of PATCH /pickup-orders/:id/cancel. No DB or network: class-validator directly.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CancelPickupOrderDto } from './cancel-pickup-order.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function invalidProperties(plain: object): Promise<string[]> {
    return (await validate(plainToInstance(CancelPickupOrderDto, plain), OPTIONS)).map((e) => e.property);
}

describe('CancelPickupOrderDto', () => {
    it('accepts a causal and trims it', async () => {
        const dto = plainToInstance(CancelPickupOrderDto, { reason: '  El cliente desistió  ' });

        expect(await validate(dto, OPTIONS)).toEqual([]);
        expect(dto.reason).toBe('El cliente desistió');
    });

    it.each([undefined, '', '   ', 5, null])('rejects the causal %j', async (reason) => {
        expect(await invalidProperties({ reason })).toEqual(['reason']);
    });

    it('rejects a causal above 500 characters and extra fields', async () => {
        expect(await invalidProperties({ reason: 'x'.repeat(501) })).toEqual(['reason']);
        expect(await invalidProperties({ reason: 'ok', status: 'cancelled' })).toEqual(['status']);
    });
});
