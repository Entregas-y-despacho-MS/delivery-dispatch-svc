import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { FindAdminAuditEventsParamsDto } from './find-admin-audit-events-params.dto.js';

const window = { from: '2026-11-20T00:00:00-04:00', to: '2026-11-21T00:00:00-04:00' };
const parse = (plain: Record<string, unknown>) => plainToInstance(FindAdminAuditEventsParamsDto, { ...window, ...plain });

describe('FindAdminAuditEventsParamsDto', () => {
    it('accepts only the window and applies the defaults', async () => {
        const dto = parse({});
        await expect(validate(dto)).resolves.toHaveLength(0);
        expect(dto).toMatchObject({ page: 1, limit: 10, order: 'desc' });
    });

    it('accepts and converts every filter coming from the query string', async () => {
        const dto = parse({ actorId: '4', actorRole: 'admin', action: 'user.role_changed', entityType: 'user', entityId: ' 12 ', result: 'denied', correlationId: 'req-123456', order: 'asc', page: '2', limit: '100' });
        await expect(validate(dto)).resolves.toHaveLength(0);
        expect(dto).toMatchObject({ actorId: 4, entityId: '12', page: 2, limit: 100, order: 'asc' });
    });

    it.each([undefined, '', '2026-11-20', '2026-11-20T00:00:00', '2026-11-20 00:00:00Z', '2026-13-20T00:00:00Z', '2026-02-30T00:00:00Z'])('rejects the missing or zone-less date %s', async (value) => {
        expect(await validate(parse({ from: value }))).not.toHaveLength(0);
        expect(await validate(parse({ to: value }))).not.toHaveLength(0);
    });

    it.each([
        { limit: '101' }, { limit: '0' }, { page: '0' }, { actorId: '0' }, { actorId: '2147483648' }, { actorId: 'x' },
        { actorRole: 'boss' }, { action: 'user.exploded' }, { entityType: 'planet' }, { result: 'maybe' },
        { correlationId: 'short' }, { correlationId: 'has spaces in it' }, { order: 'sideways' }, { entityId: 'a b' }, { entityId: 'x'.repeat(65) },
    ])('rejects %o', async (query) => {
        expect(await validate(parse(query))).not.toHaveLength(0);
    });
});
