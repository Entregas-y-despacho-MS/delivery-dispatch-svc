import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CancelDispatchDto } from './cancel-dispatch.dto.js';

async function check(body: Record<string, unknown>) {
    const dto = plainToInstance(CancelDispatchDto, body);
    return { dto, failing: (await validate(dto)).map((error) => error.property) };
}

describe('CancelDispatchDto', () => {
    it('accepts a reason and trims the spaces around it', async () => {
        const { dto, failing } = await check({ reason: '  The package did not appear at the cotejo.  ' });
        expect(failing).toEqual([]);
        expect(dto.reason).toBe('The package did not appear at the cotejo.');
    });

    it.each([[''], ['   '], ['\t\n'], [undefined], [12], ['x'.repeat(501)]])('rejects the reason %j', async (reason) => {
        expect((await check({ reason })).failing).toEqual(['reason']);
    });
});
