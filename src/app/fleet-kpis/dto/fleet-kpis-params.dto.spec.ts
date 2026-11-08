import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { FleetKpisParamsDto } from './fleet-kpis-params.dto.js';

const messagesOf = async (plain: object) =>
    (await validate(plainToInstance(FleetKpisParamsDto, plain))).flatMap((e) => Object.values(e.constraints ?? {}));

describe('FleetKpisParamsDto', () => {
    it.each(['today', 'week', 'month'])('accepts %s', async (period) => {
        expect(await messagesOf({ period })).toEqual([]);
    });

    it.each([{}, { period: 'year' }, { period: '' }])('rejects %j', async (query) => {
        expect(await messagesOf(query)).toContain("The 'period' parameter must be one of: today, week, month.");
    });
});
