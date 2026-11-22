import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FleetAvailabilityParamsDto } from './fleet-availability-params.dto.js';

const parse = (plain: Record<string, unknown>) => plainToInstance(FleetAvailabilityParamsDto, plain);

describe('FleetAvailabilityParamsDto', () => {
    it('accepts an empty query (every parameter is optional)', async () => {
        await expect(validate(parse({}))).resolves.toHaveLength(0);
    });

    it('accepts and converts every filter coming from the query string', async () => {
        const dto = parse({ cutoff: '2026-11-19', from: '2026-11-01', to: '2026-11-19', vehicleId: '7', driverId: '3', fleetStatus: 'MAINTENANCE', maintenanceTypeId: '2', routine: 'false' });
        await expect(validate(dto)).resolves.toHaveLength(0);
        expect(dto).toMatchObject({ vehicleId: 7, driverId: 3, fleetStatus: 'maintenance', maintenanceTypeId: 2, routine: false });
    });

    it.each(['2026-2-01', '2026-02-30', '2026-11-19T00:00:00Z'])('rejects invalid cutoff %s', async (value) => {
        expect(await validate(parse({ cutoff: value }))).not.toHaveLength(0);
    });

    it.each([{ fleetStatus: 'broken' }, { vehicleId: '0' }, { driverId: 'abc' }, { maintenanceTypeId: '2147483648' }, { routine: 'yes' }])('rejects %o', async (query) => {
        expect(await validate(parse(query))).not.toHaveLength(0);
    });
});
