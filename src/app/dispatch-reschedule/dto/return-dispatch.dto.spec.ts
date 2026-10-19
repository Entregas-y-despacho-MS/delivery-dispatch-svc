import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ReturnDispatchDto } from './return-dispatch.dto.js';

async function failing(body: Record<string, unknown>): Promise<string[]> {
    return (await validate(plainToInstance(ReturnDispatchDto, body))).map((error) => error.property);
}

describe('ReturnDispatchDto', () => {
    it('accepts an empty body, a note or a null note', async () => {
        expect(await failing({})).toEqual([]);
        expect(await failing({ notes: 'Customer unreachable' })).toEqual([]);
        expect(await failing({ notes: null })).toEqual([]);
    });

    it.each([['x'.repeat(501)], [12]])('rejects the note %s', async (notes) => {
        expect(await failing({ notes })).toEqual(['notes']);
    });
});
