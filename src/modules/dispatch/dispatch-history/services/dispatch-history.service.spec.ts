import { describe, expect, it, vi } from 'vitest';
import { DispatchHistoryService } from './dispatch-history.service.js';
import { InvalidHistoryDateRangeException } from '../exceptions/index.js';
import { FindDispatchHistoryParamsDto } from '../dto/find-dispatch-history-params.dto.js';

function params(overrides: Partial<FindDispatchHistoryParamsDto> = {}): FindDispatchHistoryParamsDto {
    return Object.assign(new FindDispatchHistoryParamsDto(), { page: 1, limit: 10 }, overrides);
}

const closedAt = new Date('2026-10-10T18:30:00.000Z');
const row = (overrides: Record<string, unknown> = {}) => ({
    id: 1, tracking_code: 'DSP-2026-00001', recipient: 'María', driver_id: 7, driver_name: 'Juan', plate: '1234ABC',
    status: 'delivered', closed_at: closedAt, ...overrides,
});

function service(responses: unknown[][]) {
    const query = vi.fn();
    for (const response of responses) query.mockResolvedValueOnce(response);
    return { service: new DispatchHistoryService({ query } as never), query };
}

describe('DispatchHistoryService.findAll', () => {
    it('answers { data, total, page, limit } with the departure and the delivery time', async () => {
        const { service: history } = service([
            [{ total: 25 }],
            [row()],
            [{ dispatch_id: 1, departed_at: '2026-10-10T13:00:00.000Z', event_at: new Date('2026-10-10T13:00:01.000Z') }],
        ]);

        const result = await history.findAll(params({ page: 2, limit: 10 }));

        expect(result.total).toBe(25);
        expect(result.page).toBe(2);
        expect(result.limit).toBe(10);
        expect(result.data).toEqual([{
            id: 1, trackingCode: 'DSP-2026-00001', recipient: 'María', driverId: 7, driverName: 'Juan', plate: '1234ABC',
            departedAt: new Date('2026-10-10T13:00:00.000Z'), deliveredAt: closedAt, status: 'delivered', closedAt,
        }]);
    });

    it('asks for the page with LIMIT and OFFSET bound as parameters', async () => {
        const { service: history, query } = service([[{ total: 0 }], [], []]);

        await history.findAll(params({ page: 3, limit: 20, driverId: 7 }));

        const [pageSql, pageArgs] = query.mock.calls[1];
        expect(pageSql).toMatch(/LIMIT \$2 OFFSET \$3/);
        expect(pageArgs).toEqual([7, 20, 40]);
        const [countSql, countArgs] = query.mock.calls[0];
        expect(countSql).toMatch(/COUNT\(\*\)/);
        expect(countArgs).toEqual([7, 20, 40]);
    });

    it('does not look for departures when the page is empty', async () => {
        const { service: history, query } = service([[{ total: 0 }], []]);

        const result = await history.findAll(params());

        expect(result).toEqual({ data: [], total: 0, page: 1, limit: 10 });
        expect(query).toHaveBeenCalledTimes(2);
    });

    it('leaves the delivery time empty unless the dispatch was delivered', async () => {
        const { service: history } = service([
            [{ total: 3 }],
            [row({ id: 1, status: 'not_delivered' }), row({ id: 2, status: 'returned' }), row({ id: 3, status: 'cancelled' })],
            [],
        ]);

        const { data } = await history.findAll(params());

        expect(data.map((item) => item.deliveredAt)).toEqual([null, null, null]);
        expect(data.map((item) => item.departedAt)).toEqual([null, null, null]);
    });

    it('uses the time of the event when the departure metadata is missing or malformed', async () => {
        const eventAt = new Date('2026-10-10T13:00:01.000Z');
        const { service: history } = service([
            [{ total: 2 }],
            [row({ id: 1 }), row({ id: 2 })],
            [
                { dispatch_id: 1, departed_at: null, event_at: eventAt },
                { dispatch_id: 2, departed_at: 'not a date', event_at: eventAt },
            ],
        ]);

        const { data } = await history.findAll(params());

        expect(data.map((item) => item.departedAt)).toEqual([eventAt, eventAt]);
    });

    it('keeps a dispatch without a route, with empty driver and vehicle', async () => {
        const { service: history } = service([
            [{ total: 1 }],
            [row({ driver_id: null, driver_name: null, plate: null, status: 'cancelled' })],
            [],
        ]);

        const { data } = await history.findAll(params());

        expect(data[0]).toMatchObject({ driverId: null, driverName: null, plate: null, status: 'cancelled' });
    });

    it('rejects a range whose start is after its end before touching the database', async () => {
        const { service: history, query } = service([]);

        await expect(history.findAll(params({ from: '2026-10-06', to: '2026-10-05' }))).rejects.toThrow(InvalidHistoryDateRangeException);
        expect(query).not.toHaveBeenCalled();
    });
});
