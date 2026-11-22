import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { PlanningPipelineParamsDto } from './planning-pipeline-params.dto.js';

async function messagesOf(query: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(plainToInstance(PlanningPipelineParamsDto, query));
    return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('PlanningPipelineParamsDto', () => {
    it('accepts no filter at all and every filter together', async () => {
        expect(await messagesOf({})).toEqual([]);
        expect(await messagesOf({ date: '2026-11-23', zoneId: '3', warehouseId: '2', shift: 'MORNING', stage: 'Exception', page: '2', limit: '20' })).toEqual([]);
    });

    it('rejects a date that is not YYYY-MM-DD or does not exist', async () => {
        expect(await messagesOf({ date: '23/11/2026' })).not.toEqual([]);
        expect(await messagesOf({ date: '2026-02-30' })).not.toEqual([]);
    });

    it('rejects an unknown shift or stage', async () => {
        expect(await messagesOf({ shift: 'night' })).toContain("The 'shift' parameter must be one of: morning, afternoon.");
        expect(await messagesOf({ stage: 'done' })).not.toEqual([]);
    });

    it('rejects ids that are not whole numbers in range', async () => {
        expect(await messagesOf({ zoneId: '0' })).not.toEqual([]);
        expect(await messagesOf({ warehouseId: 'abc' })).not.toEqual([]);
        expect(await messagesOf({ zoneId: '2147483648' })).not.toEqual([]);
    });
});
