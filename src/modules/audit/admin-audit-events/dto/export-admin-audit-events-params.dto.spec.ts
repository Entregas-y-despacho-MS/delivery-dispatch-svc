import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ExportAdminAuditEventsParamsDto } from './export-admin-audit-events-params.dto.js';

const window = { from: '2026-11-20T00:00:00-04:00', to: '2026-11-21T00:00:00-04:00' };
const parse = (plain: Record<string, unknown>) => plainToInstance(ExportAdminAuditEventsParamsDto, { ...window, ...plain });

describe('ExportAdminAuditEventsParamsDto', () => {
    it.each([['csv'], ['pdf'], [' PDF '], ['CSV']])('accepts the format %j', async (format) => {
        const dto = parse({ format });
        await expect(validate(dto)).resolves.toHaveLength(0);
        expect(['csv', 'pdf']).toContain(dto.format);
    });

    it.each([undefined, '', 'xlsx', 'json', 'csv,pdf'])('rejects the missing or unknown format %j', async (format) => {
        expect(await validate(parse({ format }))).not.toHaveLength(0);
    });

    it('accepts every filter of the search, and the page and limit the screen sends along', async () => {
        const dto = parse({ format: 'csv', actorId: '4', action: 'user.created', entityType: 'user', entityId: '9', result: 'success', order: 'asc', page: '3', limit: '20' });
        await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('keeps the rules of the window: it is required and carries an offset', async () => {
        expect(await validate(parse({ format: 'csv', from: '2026-11-20' }))).not.toHaveLength(0);
        expect(await validate(parse({ format: 'csv', to: undefined }))).not.toHaveLength(0);
    });
});
