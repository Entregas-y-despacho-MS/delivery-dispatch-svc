import { describe, expect, it, vi } from 'vitest';
import { FindComplaintCasesParamsDto } from '../dto/find-complaint-cases-params.dto.js';
import { ComplaintCaseNotFoundException, InvalidComplaintDateRangeException } from '../exceptions/index.js';
import { ComplaintCasesService } from './complaint-cases.service.js';

function params(overrides: Partial<FindComplaintCasesParamsDto> = {}): FindComplaintCasesParamsDto {
    return Object.assign(new FindComplaintCasesParamsDto(), { page: 1, limit: 10 }, overrides);
}

const at = new Date('2026-11-20T15:00:00.000Z');
const row = (overrides: Record<string, unknown> = {}) => ({
    complaint_id: 12, crm_case_id: 'CRM-1', dispatch_id: 245, tracking_code: 'DSP-245', case_version: 2, reason_code: 'damaged_item',
    investigation_status: 'received', dispatch_status: 'delivered', zone_id: 3, zone_name: 'Zona Sur', assigned_user_id: null,
    assigned_user_name: null, verdict: null, rma_id: null, received_at: at, opened_at: at, assigned_at: null, decided_at: null,
    updated_at: at, ...overrides,
});
const detailRow = (overrides: Record<string, unknown> = {}) => row({
    investigation_started_at: null, findings: null, decision_reason: null, decided_by_user_id: null, decided_by_user_name: null,
    authorization_request_id: null, affected_items: [{ itemCode: 'SKU-1', quantity: 2 }], route_batch_id: 9, route_batch_status: 'in_execution',
    ...overrides,
});

function service(responses: unknown[][]) {
    const query = vi.fn();
    for (const response of responses) query.mockResolvedValueOnce(response);
    return { service: new ComplaintCasesService({ query } as never), query };
}

describe('ComplaintCasesService.findAll', () => {
    it('with no cases answers an empty page', async () => {
        const { service: cases } = service([[{ total: 0 }], []]);

        const result = await cases.findAll(params());

        expect(result).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
    });

    it('with one case maps it without customer data and with its next action', async () => {
        const { service: cases } = service([[{ total: 1 }], [row()]]);

        const result = await cases.findAll(params());

        expect(result.meta).toEqual({ page: 1, limit: 10, total: 1, pages: 1 });
        expect(result.data).toEqual([{
            complaintId: 12, crmCaseId: 'CRM-1', dispatchId: 245, trackingCode: 'DSP-245', caseVersion: 2, reasonCode: 'damaged_item',
            investigationStatus: 'received', nextAction: 'assign', eligible: true, dispatchStatus: 'delivered', zoneId: 3, zoneName: 'Zona Sur',
            assignedUserId: null, assignedUserName: null, verdict: null, authorizationPending: false, receivedAt: at, openedAt: at,
            assignedAt: null, decidedAt: null, updatedAt: at,
        }]);
        for (const forbidden of ['contactName', 'phone', 'email', 'address', 'evidenceUrl', 'affectedItems']) {
            expect(result.data[0]).not.toHaveProperty(forbidden);
        }
    });

    it('with many cases computes the pages and applies the offset of the requested page', async () => {
        const { service: cases, query } = service([[{ total: 25 }], [row({ complaint_id: 11 }), row({ complaint_id: 10 })]]);

        const result = await cases.findAll(params({ page: 3, limit: 10 }));

        expect(result.meta).toEqual({ page: 3, limit: 10, total: 25, pages: 3 });
        expect(result.data.map((item) => item.complaintId)).toEqual([11, 10]);
        const [sql, args] = query.mock.calls[1];
        expect(sql).toContain('ORDER BY c.consumed_at DESC, c.delivery_complaint_case_id DESC');
        expect(args.slice(-2)).toEqual([10, 20]);
    });

    it('passes the filters as bound values to both the count and the page', async () => {
        const { service: cases, query } = service([[{ total: 0 }], []]);

        await cases.findAll(params({ status: 'assigned', zoneId: 3 }));

        // The page query appends limit and offset to the same array after the count has run: compare the filters only.
        expect(query.mock.calls[0][1].slice(0, 2)).toEqual([3, 'assigned']);
        expect(query.mock.calls[0][0]).toContain('d.delivery_zone_id = $1');
        expect(query.mock.calls[1][0]).toContain('c.investigation_status = $2');
    });

    it('flags a request_RMA verdict without RMA id as pending authorization', async () => {
        const { service: cases } = service([[{ total: 1 }], [row({ investigation_status: 'decided', verdict: 'request_RMA', decided_at: at })]]);

        const [item] = (await cases.findAll(params())).data;

        expect(item.authorizationPending).toBe(true);
        expect(item.nextAction).toBe('await_inventory_authorization');
    });

    it('a case whose dispatch is not delivered is not eligible and offers no action', async () => {
        const { service: cases } = service([[{ total: 1 }], [row({ dispatch_status: 'returned' })]]);

        const [item] = (await cases.findAll(params())).data;

        expect(item.eligible).toBe(false);
        expect(item.nextAction).toBe('none');
    });

    it('rejects an inverted date range before touching the database', async () => {
        const { service: cases, query } = service([]);

        await expect(cases.findAll(params({ from: '2026-11-10', to: '2026-11-01' }))).rejects.toThrow(InvalidComplaintDateRangeException);
        expect(query).not.toHaveBeenCalled();
    });
});

describe('ComplaintCasesService.findOne', () => {
    it('reads a case while its route batch is still in execution', async () => {
        const { service: cases } = service([[detailRow()]]);

        const detail = await cases.findOne(12);

        expect(detail.eligible).toBe(true);
        expect(detail.routeBatchId).toBe(9);
        expect(detail.routeBatchStatus).toBe('in_execution');
        expect(detail.affectedItems).toEqual([{ itemCode: 'SKU-1', quantity: 2 }]);
        expect(detail.rmaId).toBeNull();
    });

    it('answers 404 for a case that does not exist', async () => {
        const { service: cases } = service([[]]);

        await expect(cases.findOne(999)).rejects.toThrow(ComplaintCaseNotFoundException);
    });
});
