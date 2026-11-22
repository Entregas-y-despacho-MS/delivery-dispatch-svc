import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { FindComplaintCasesParamsDto } from './find-complaint-cases-params.dto.js';

const errorsOf = async (plain: Record<string, unknown>) =>
    (await validate(plainToInstance(FindComplaintCasesParamsDto, plain))).flatMap((error) => Object.values(error.constraints ?? {}));

describe('FindComplaintCasesParamsDto dates', () => {
    it('accepts real days from 1900 on', async () => {
        expect(await errorsOf({ from: '1900-01-01', to: '2040-12-31' })).toEqual([]);
    });

    it('rejects year 0000 (Postgres cannot cast it) and impossible days', async () => {
        for (const from of ['0000-01-01', '0099-05-05', '2040-02-30', '2040-13-01', '10/03/2040']) {
            expect(await errorsOf({ from })).toContain("The 'from' parameter must be a valid date in YYYY-MM-DD format.");
        }
    });
});
