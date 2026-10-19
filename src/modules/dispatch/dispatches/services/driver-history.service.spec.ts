import { describe, expect, it, vi } from 'vitest';
import { DriverHistoryService } from './driver-history.service.js';

function build(rows: unknown[] = [], total = 0) {
    const dataSource = { query: vi.fn().mockResolvedValueOnce([{ total }]).mockResolvedValueOnce(rows) };
    return { service: new DriverHistoryService(dataSource as any), dataSource };
}

describe('DriverHistoryService.findHistory', () => {
    it('defaults pagination and returns the selected evidence with each history row', async () => {
        const item = {
            tracking_code: 'DSP-2026-00001', customer_name: 'Cliente', receiver_name: 'Receptor',
            status: 'delivered', closed_at: new Date('2026-10-19T14:00:00.000Z'), evidence_id: 'evidence-uuid',
        };
        const { service, dataSource } = build([item], 1);

        await expect(service.findHistory(7, {})).resolves.toEqual({
            data: [{ trackingCode: item.tracking_code, customerName: item.customer_name, receiverName: item.receiver_name, status: item.status, closedAt: item.closed_at, evidenceId: item.evidence_id }],
            total: 1, page: 1, limit: 20,
        });
        expect(dataSource.query).toHaveBeenCalledTimes(2);
        expect(dataSource.query.mock.calls[0][1]).toEqual([7]);
        expect(dataSource.query.mock.calls[1][1]).toEqual([7, 20, 0]);
        expect(dataSource.query.mock.calls[1][0]).toContain("ORDER BY e.captured_at DESC NULLS LAST, e.created_at DESC, e.delivery_evidence_id DESC");
    });

    it('applies driver isolation, status, inclusive La Paz date boundaries, escaped tracking search and page offset', async () => {
        const { service, dataSource } = build([], 0);
        await expect(service.findHistory(12, { page: 3, limit: 5, from: '2026-10-01', to: '2026-10-19', status: 'returned', search: 'DSP_%' })).resolves.toEqual({ data: [], total: 0, page: 3, limit: 5 });

        const [countSql, countValues] = dataSource.query.mock.calls[0];
        const [rowsSql, rowsValues] = dataSource.query.mock.calls[1];
        expect(countSql).toContain('rb.driver_id = $1');
        expect(countSql).toContain("s.name IN ('delivered', 'returned')");
        expect(countSql).toContain("AT TIME ZONE 'America/La_Paz'");
        expect(countSql).toContain('d.tracking_code ILIKE');
        expect(countValues).toEqual([12, 'returned', '2026-10-01', '2026-10-19', '%DSP\\_\\%%']);
        expect(rowsSql).toContain('LIMIT $6 OFFSET $7');
        expect(rowsValues).toEqual([...countValues, 5, 10]);
    });

    it('returns an empty page and numeric total when there are no matching dispatches', async () => {
        const { service } = build([], '0' as any);
        await expect(service.findHistory(7, {})).resolves.toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });
});
