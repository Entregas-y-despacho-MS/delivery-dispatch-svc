import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { FleetReportsParamsDto } from './fleet-reports-params.dto.js';

describe('FleetReportsParamsDto', () => {
    it('accepts strict YYYY-MM-DD dates', async () => {
        const dto = Object.assign(new FleetReportsParamsDto(), { from: '2026-10-01', to: '2026-10-31' });
        await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it.each(['2026-2-01', '2026-02-30', '2026-10-01T00:00:00Z'])('rejects invalid date %s', async (value) => {
        const dto = Object.assign(new FleetReportsParamsDto(), { from: value, to: '2026-10-31' });
        expect(await validate(dto)).not.toHaveLength(0);
    });
});
