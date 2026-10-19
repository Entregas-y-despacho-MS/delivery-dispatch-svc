import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { FindChangeRequestsParamsDto } from '../dto/find-change-requests-params.dto.js';
import { CustomerChangeRequestsService } from './customer-change-requests.service.js';

const REQUESTED_AT = new Date('2026-10-19T14:00:00Z');

const row = (over: Record<string, unknown> = {}) => ({
    dispatch_id: 7,
    tracking_code: 'TRK-000007',
    status: 'scheduled',
    route_batch_id: 500,
    delivery_date: '2026-10-21',
    scheduled_window_start: new Date('2026-10-21T13:00:00Z'),
    scheduled_window_end: new Date('2026-10-21T15:00:00Z'),
    zone_id: 3,
    zone_name: 'Zona Sur',
    contact_name: 'Ana Perez',
    has_contact_email: false,
    has_live_token: true,
    promise_firmed_at: null,
    request_detail: 'After the 28th, please.',
    requested_at: REQUESTED_AT,
    window_was_open: true,
    closed_reason: null,
    ...over,
});

function params(over: Partial<FindChangeRequestsParamsDto> = {}): FindChangeRequestsParamsDto {
    return Object.assign(new FindChangeRequestsParamsDto(), over);
}

function setup(rows: Record<string, unknown>[], total = rows.length) {
    const query = vi.fn(async (sql: string) => (sql.includes('COUNT(*)') ? [{ total }] : rows));
    return { service: new CustomerChangeRequestsService({ query } as any), query };
}

describe('CustomerChangeRequestsService.findAll', () => {
    it('lists what the customer asked, where the delivery is and the state of the promise', async () => {
        const { service } = setup([row()]);

        const result = await service.findAll(params(), RoleEnum.COORDINATOR);

        expect(result.meta).toEqual({ page: 1, limit: 10, total: 1, pages: 1 });
        expect(result.data[0]).toEqual({
            dispatchId: 7,
            trackingCode: 'TRK-000007',
            status: 'scheduled',
            routeBatchId: 500,
            deliveryDate: '2026-10-21',
            windowStart: new Date('2026-10-21T13:00:00Z'),
            windowEnd: new Date('2026-10-21T15:00:00Z'),
            zoneId: 3,
            zoneName: 'Zona Sur',
            contactName: 'Ana Perez',
            hasContactEmail: false,
            request: { detail: 'After the 28th, please.', requestedAt: REQUESTED_AT, responseWindowWasOpen: true, selfServiceClosedReason: null },
            promiseIsFirm: false,
            promiseFirmedAt: null,
            canRevealTrackingLink: true,
        });
    });

    it('says the promise is firm when it is, and why the self-service was over when the customer asked', async () => {
        const firmedAt = new Date('2026-10-19T10:00:00Z');
        const { service } = setup([row({ promise_firmed_at: firmedAt, window_was_open: false, closed_reason: 'window_elapsed' })]);

        const [item] = (await service.findAll(params(), RoleEnum.SUPERVISOR)).data;

        expect(item).toMatchObject({ promiseIsFirm: true, promiseFirmedAt: firmedAt });
        expect(item.request).toMatchObject({ responseWindowWasOpen: false, selfServiceClosedReason: 'window_elapsed' });
    });

    it('keeps a request without text or metadata instead of dropping it', async () => {
        const { service } = setup([row({ request_detail: null, window_was_open: null, closed_reason: null })]);

        const [item] = (await service.findAll(params(), RoleEnum.COORDINATOR)).data;

        expect(item.request).toMatchObject({ detail: null, responseWindowWasOpen: null, selfServiceClosedReason: null });
    });

    describe('the tracking link', () => {
        it('is offered only to a coordinator, for a customer without email and with a working token', async () => {
            const { service } = setup([
                row({ dispatch_id: 1 }),
                row({ dispatch_id: 2, has_contact_email: true }),
                row({ dispatch_id: 3, has_live_token: false }),
            ]);

            const asCoordinator = await service.findAll(params(), RoleEnum.COORDINATOR);
            const asSupervisor = await service.findAll(params(), RoleEnum.SUPERVISOR);

            expect(asCoordinator.data.map((item) => item.canRevealTrackingLink)).toEqual([true, false, false]);
            expect(asSupervisor.data.map((item) => item.canRevealTrackingLink)).toEqual([false, false, false]);
        });

        it('never travels in the list: not in the rows read, not in the answer', async () => {
            const { service, query } = setup([row({ tracking_token: 'a-secret-token-value', contact_email: 'ana@example.test', contact_phone: '+591 70000000' })]);

            const result = await service.findAll(params(), RoleEnum.COORDINATOR);

            const sql = query.mock.calls.map((call) => String(call[0])).join(' ');
            // The token is only tested for existence, never selected.
            expect(sql).not.toMatch(/d\.tracking_token\s*(,|AS|FROM)/);
            // The email is only tested for presence (a boolean), never selected as a column.
            expect(sql.replace("(d.contact_email IS NOT NULL AND btrim(d.contact_email) <> '') AS has_contact_email", '')).not.toContain('contact_email');
            const serialized = JSON.stringify(result);
            for (const secret of ['a-secret-token-value', 'ana@example.test', '70000000', 'tracking_token', 'trackingUrl']) {
                expect(serialized).not.toContain(secret);
            }
        });
    });

    describe('what the list contains', () => {
        it('is only the pending requests of deliveries a coordinator can still decide', async () => {
            const { service, query } = setup([row()]);

            await service.findAll(params(), RoleEnum.COORDINATOR);

            const [sql, values] = query.mock.calls[0];
            expect(sql).toContain("d.customer_confirmation = 'change_requested'");
            expect(sql).toContain('s.name = ANY($1::text[])');
            expect(values[0]).toEqual(['scheduled', 'assigned']);
        });

        it('uses the last request of the customer, and puts the oldest request first', async () => {
            const { service, query } = setup([row()]);

            await service.findAll(params(), RoleEnum.COORDINATOR);

            const data = String(query.mock.calls[1][0]).replace(/\s+/g, ' ');
            expect(data).toContain("e.event_type = 'change_requested' ORDER BY e.created_at DESC, e.dispatch_event_id DESC LIMIT 1");
            expect(data).toContain('ORDER BY COALESCE(r.created_at, d.updated_at), d.dispatch_id');
        });
    });

    describe('filters, always as bound values', () => {
        it('narrows by zone and by the date of the route', async () => {
            const { service, query } = setup([row()]);

            await service.findAll(params({ delivery_zone_id: 3, date: '2026-10-21' }), RoleEnum.COORDINATOR);

            const [sql, values] = query.mock.calls[0];
            expect(sql).toContain('d.delivery_zone_id = $2');
            expect(sql).toContain('rb.shift_date = $3::date');
            expect(values).toEqual([['scheduled', 'assigned'], 3, '2026-10-21']);
            expect(sql).not.toMatch(/= 3\b|2026-10-21/);
        });

        it('searches the tracking code and the contact name with the wildcards escaped', async () => {
            const { service, query } = setup([row()]);

            await service.findAll(params({ search: '50%_\\' }), RoleEnum.COORDINATOR);

            const [sql, values] = query.mock.calls[0];
            expect(sql).toContain('d.tracking_code ILIKE $2 OR d.contact_name ILIKE $2');
            expect(values[1]).toBe('%50\\%\\_\\\\%');
        });

        it('adds nothing when there are no filters', async () => {
            const { service, query } = setup([row()]);

            await service.findAll(params(), RoleEnum.COORDINATOR);

            const [sql, values] = query.mock.calls[0];
            expect(sql).not.toContain('d.delivery_zone_id = $');
            expect(sql).not.toContain('shift_date =');
            expect(sql).not.toContain('ILIKE');
            expect(values).toHaveLength(1);
        });
    });

    describe('pagination', () => {
        it('asks for the page and the limit with an offset', async () => {
            const { service, query } = setup([row()], 45);

            const result = await service.findAll(params({ page: 3, limit: 10 }), RoleEnum.COORDINATOR);

            const [, values] = query.mock.calls[1];
            expect(values.slice(-2)).toEqual([10, 20]);
            expect(result.meta).toEqual({ page: 3, limit: 10, total: 45, pages: 5 });
        });

        it('does not read a page when there is nothing, and says zero pages', async () => {
            const { service, query } = setup([], 0);

            const result = await service.findAll(params(), RoleEnum.COORDINATOR);

            expect(query).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
        });

        it('counts with the same filters it lists with', async () => {
            const { service, query } = setup([row()]);

            await service.findAll(params({ delivery_zone_id: 3, search: 'ana' }), RoleEnum.COORDINATOR);

            expect(query.mock.calls[0][1]).toEqual(query.mock.calls[1][1].slice(0, query.mock.calls[0][1].length));
        });
    });
});
