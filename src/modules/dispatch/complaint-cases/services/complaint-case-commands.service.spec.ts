import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MessageValidator } from '../../../../plugins/messaging/envelope/message-validator.js';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { AssignComplaintCaseDto, IssueComplaintVerdictDto, StartComplaintInvestigationDto } from '../dto/complaint-case-commands.dto.js';
import {
    ComplaintCaseNotFoundException,
    ComplaintCaseVersionStaleException,
    ComplaintDispatchNotDeliveredException,
    ComplaintReferenceNotCorrelatedException,
    InvalidComplaintAssigneeException,
    InvalidComplaintTransitionException,
} from '../exceptions/index.js';
import { ComplaintCaseCommandsService } from './complaint-case-commands.service.js';

const validator = MessageValidator.fromDirectory(resolve(process.cwd(), 'contracts/messages'));

const ACTOR = 7;

const lockedRow = (overrides: Record<string, unknown> = {}) => ({
    complaint_id: 12, crm_case_id: 'CRM-CASE-1', case_version: 1, tracking_code: 'DSP-2026-00482', reason_code: 'DAMAGED_ITEM',
    affected_items: [{ itemCode: 'SKU-1042', quantity: 1 }], investigation_status: 'received', assigned_user_id: null,
    verdict: null, decision_reason: null, findings: null, dispatch_id: 482, dispatch_type: 'delivery',
    dispatch_tracking_code: 'DSP-2026-00482', dispatch_status: 'delivered', source_order_ref: 'SO-2026-004711',
    ...overrides,
});

function setup(row: Record<string, unknown> | null, assigneeRole: string | null = 'supervisor') {
    const updates: { sql: string; args: unknown[] }[] = [];
    const manager = {
        query: vi.fn(async (sql: string, args: unknown[] = []) => {
            if (sql.includes('FOR UPDATE OF c')) return row ? [row] : [];
            if (sql.includes('FROM users u')) return assigneeRole ? [{ role: assigneeRole }] : [];
            if (sql.trimStart().startsWith('UPDATE')) { updates.push({ sql, args }); return [[], 1]; }
            throw new Error(`unexpected SQL: ${sql}`);
        }),
    };
    const dataSource = { transaction: vi.fn(async (work: (m: unknown) => Promise<void>) => await work(manager)) };
    const enqueued: { envelope: MessageEnvelope; options: unknown }[] = [];
    const outbox = { enqueue: vi.fn(async (envelope: MessageEnvelope, options: unknown) => { enqueued.push({ envelope, options }); return true; }) };
    const detail = { complaintId: 12 };
    const cases = { findOne: vi.fn(async () => detail) };
    const service = new ComplaintCaseCommandsService(dataSource as never, outbox as never, cases as never);
    return { service, manager, updates, outbox, enqueued, cases, detail };
}

const assignDto = (overrides: Partial<AssignComplaintCaseDto> = {}) => Object.assign(new AssignComplaintCaseDto(), { expectedVersion: 1 }, overrides);
const startDto = (overrides: Partial<StartComplaintInvestigationDto> = {}) => Object.assign(new StartComplaintInvestigationDto(), { expectedVersion: 1 }, overrides);
const verdictDto = (overrides: Partial<IssueComplaintVerdictDto> = {}) => Object.assign(new IssueComplaintVerdictDto(), {
    expectedVersion: 1, verdict: 'not_confirmed', decisionReason: 'No damage found.', findings: 'The photos show an intact package.',
}, overrides);

describe('ComplaintCaseCommandsService.assign', () => {
    it('puts the person making the request in charge of a received case and answers the committed case', async () => {
        const { service, updates, cases, detail } = setup(lockedRow());

        await expect(service.assign(12, assignDto(), ACTOR)).resolves.toBe(detail);

        expect(updates).toHaveLength(1);
        expect(updates[0].sql).toContain("investigation_status = 'assigned'");
        expect(updates[0].args.slice(0, 2)).toEqual([12, ACTOR]);
        expect(updates[0].args[2]).toBeInstanceOf(Date);
        expect(cases.findOne).toHaveBeenCalledWith(12);
    });

    it('assigns another active supervisor or coordinator', async () => {
        const { service, updates } = setup(lockedRow(), 'coordinator');

        await service.assign(12, assignDto({ assigneeUserId: 9 }), ACTOR);

        expect(updates[0].args[1]).toBe(9);
    });

    it.each(['admin', 'driver', 'root'])('rejects an assignee with role %s', async (role) => {
        const { service, updates } = setup(lockedRow(), role);

        await expect(service.assign(12, assignDto({ assigneeUserId: 9 }), ACTOR)).rejects.toThrow(InvalidComplaintAssigneeException);
        expect(updates).toHaveLength(0);
    });

    it('rejects an assignee that does not exist or is inactive', async () => {
        const { service } = setup(lockedRow(), null);

        await expect(service.assign(12, assignDto({ assigneeUserId: 9 }), ACTOR)).rejects.toThrow(InvalidComplaintAssigneeException);
    });

    it('can hand an assigned case to someone else before the investigation starts', async () => {
        const { service, updates } = setup(lockedRow({ investigation_status: 'assigned', assigned_user_id: ACTOR }));

        await service.assign(12, assignDto({ assigneeUserId: 9 }), ACTOR);

        expect(updates).toHaveLength(1);
        expect(updates[0].args[1]).toBe(9);
    });

    it('is idempotent: repeating the same assignment writes nothing and still answers the case', async () => {
        const { service, updates, cases } = setup(lockedRow({ investigation_status: 'assigned', assigned_user_id: ACTOR }));

        await service.assign(12, assignDto(), ACTOR);

        expect(updates).toHaveLength(0);
        expect(cases.findOne).toHaveBeenCalledOnce();
    });

    it.each(['in_investigation', 'decided'])('rejects assigning a case that is already %s', async (status) => {
        const { service, updates } = setup(lockedRow({ investigation_status: status, assigned_user_id: 3 }));

        await expect(service.assign(12, assignDto(), ACTOR)).rejects.toThrow(InvalidComplaintTransitionException);
        expect(updates).toHaveLength(0);
    });

    it('rejects an old version before changing anything', async () => {
        const { service, updates } = setup(lockedRow({ case_version: 3 }));

        await expect(service.assign(12, assignDto({ expectedVersion: 2 }), ACTOR)).rejects.toThrow(ComplaintCaseVersionStaleException);
        expect(updates).toHaveLength(0);
    });

    it('rejects a case whose dispatch is not delivered', async () => {
        const { service, updates } = setup(lockedRow({ dispatch_status: 'in_transit' }));

        await expect(service.assign(12, assignDto(), ACTOR)).rejects.toThrow(ComplaintDispatchNotDeliveredException);
        expect(updates).toHaveLength(0);
    });

    it.each([
        ['a dispatch that is not a delivery', { dispatch_type: 'supplier_pickup' }],
        ['a dispatch without tracking code', { dispatch_tracking_code: null }],
        ['a tracking code that differs from the one of the dispatch', { tracking_code: 'DSP-2026-09999' }],
        ['a dispatch that no longer exists', { dispatch_type: null, dispatch_tracking_code: null, dispatch_status: null }],
    ])('rejects a case with %s as not correlated', async (_name, overrides) => {
        const { service, updates } = setup(lockedRow(overrides));

        await expect(service.assign(12, assignDto(), ACTOR)).rejects.toThrow(ComplaintReferenceNotCorrelatedException);
        expect(updates).toHaveLength(0);
    });

    it('answers 404 for a case that does not exist', async () => {
        const { service } = setup(null);

        await expect(service.assign(99, assignDto(), ACTOR)).rejects.toThrow(ComplaintCaseNotFoundException);
    });

    it('does not look at the route batch of the dispatch', async () => {
        const { service, manager } = setup(lockedRow());

        await service.assign(12, assignDto(), ACTOR);

        expect(manager.query.mock.calls.map(([sql]) => sql).join(' ')).not.toContain('route_batch');
    });
});

describe('ComplaintCaseCommandsService.startInvestigation', () => {
    it('moves an assigned case to in_investigation', async () => {
        const { service, updates } = setup(lockedRow({ investigation_status: 'assigned', assigned_user_id: ACTOR }));

        await service.startInvestigation(12, startDto());

        expect(updates).toHaveLength(1);
        expect(updates[0].sql).toContain("investigation_status = 'in_investigation'");
        expect(updates[0].args[1]).toBeInstanceOf(Date);
    });

    it.each(['received', 'decided'])('rejects starting a case that is %s', async (status) => {
        const { service, updates } = setup(lockedRow({ investigation_status: status, assigned_user_id: 3 }));

        await expect(service.startInvestigation(12, startDto())).rejects.toThrow(InvalidComplaintTransitionException);
        expect(updates).toHaveLength(0);
    });

    it('is idempotent, even if CRM sent a newer version after the investigation began', async () => {
        const { service, updates } = setup(lockedRow({ investigation_status: 'in_investigation', assigned_user_id: 3, case_version: 2 }));

        await service.startInvestigation(12, startDto({ expectedVersion: 1 }));

        expect(updates).toHaveLength(0);
    });

    it('rejects an old version', async () => {
        const { service } = setup(lockedRow({ investigation_status: 'assigned', assigned_user_id: 3, case_version: 2 }));

        await expect(service.startInvestigation(12, startDto({ expectedVersion: 1 }))).rejects.toThrow(ComplaintCaseVersionStaleException);
    });

    it('rejects a case whose dispatch is not delivered', async () => {
        const { service } = setup(lockedRow({ investigation_status: 'assigned', assigned_user_id: 3, dispatch_status: 'cancelled' }));

        await expect(service.startInvestigation(12, startDto())).rejects.toThrow(ComplaintDispatchNotDeliveredException);
    });
});

describe('ComplaintCaseCommandsService.issueVerdict', () => {
    const investigating = (overrides: Record<string, unknown> = {}) =>
        lockedRow({ investigation_status: 'in_investigation', assigned_user_id: 3, ...overrides });

    it.each(['no_return_required', 'not_confirmed'] as const)('%s stores the verdict, who and when, and requests nothing', async (verdict) => {
        const { service, updates, outbox } = setup(investigating());

        await service.issueVerdict(12, verdictDto({ verdict }), ACTOR);

        expect(updates).toHaveLength(1);
        expect(updates[0].sql).toContain("investigation_status = 'decided'");
        expect(updates[0].args.slice(0, 5)).toEqual([12, verdict, 'No damage found.', 'The photos show an intact package.', ACTOR]);
        expect(updates[0].args[5]).toBeInstanceOf(Date);
        expect(updates[0].args[6]).toBeNull();
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('request_RMA stores the request id and queues the authorization request in the same transaction', async () => {
        const { service, updates, manager, enqueued } = setup(investigating());

        await service.issueVerdict(12, verdictDto({ verdict: 'request_RMA', decisionReason: 'Factory damage.' }), ACTOR);

        expect(enqueued).toHaveLength(1);
        const { envelope, options } = enqueued[0];
        expect(options).toEqual({ manager });
        expect(envelope.type).toBe('dispatch.rma.authorization_requested');
        expect(envelope.source).toBe('dispatch');
        expect(envelope.data).toMatchObject({
            authorizationRequestId: envelope.messageId, crmCaseId: 'CRM-CASE-1', caseVersion: 1, dispatchId: 482,
            trackingCode: 'DSP-2026-00482', salesOrderId: 'SO-2026-004711', reasonCode: 'DAMAGED_ITEM',
            decisionReason: 'Factory damage.', affectedItems: [{ itemCode: 'SKU-1042', quantity: 1 }],
        });
        expect(updates[0].args[6]).toBe(envelope.messageId);
    });

    it('the authorization request satisfies the published contract and carries no customer data', async () => {
        const { service, enqueued } = setup(investigating());

        await service.issueVerdict(12, verdictDto({ verdict: 'request_RMA' }), ACTOR);

        const { envelope } = enqueued[0];
        expect(validator.validate(envelope.type, envelope)).toEqual({ valid: true });
        expect(Object.keys(envelope.data).sort()).toEqual([
            'affectedItems', 'authorizationRequestId', 'caseVersion', 'crmCaseId', 'decisionReason', 'dispatchId',
            'reasonCode', 'requestedAt', 'salesOrderId', 'trackingCode',
        ]);
    });

    it('fails the whole verdict when the request cannot be queued, so nothing is committed', async () => {
        const { service, outbox } = setup(investigating());
        outbox.enqueue.mockRejectedValueOnce(new Error('outbox down'));

        await expect(service.issueVerdict(12, verdictDto({ verdict: 'request_RMA' }), ACTOR)).rejects.toThrow('outbox down');
    });

    it('is idempotent: the same verdict again writes nothing and does not queue a second request', async () => {
        const decided = lockedRow({
            investigation_status: 'decided', assigned_user_id: 3, verdict: 'request_RMA',
            decision_reason: 'Factory damage.', findings: 'The photos show an intact package.',
        });
        const { service, updates, outbox } = setup(decided);

        await service.issueVerdict(12, verdictDto({ verdict: 'request_RMA', decisionReason: 'Factory damage.' }), ACTOR);

        expect(updates).toHaveLength(0);
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('an old version never reverts a verdict already issued', async () => {
        const decided = lockedRow({
            investigation_status: 'decided', assigned_user_id: 3, verdict: 'not_confirmed', case_version: 4,
            decision_reason: 'No damage found.', findings: 'The photos show an intact package.',
        });
        const { service, updates } = setup(decided);

        await expect(service.issueVerdict(12, verdictDto({ expectedVersion: 2 }), ACTOR)).resolves.toBeDefined();
        await expect(service.issueVerdict(12, verdictDto({ expectedVersion: 2, verdict: 'request_RMA' }), ACTOR))
            .rejects.toThrow(ComplaintCaseVersionStaleException);
        expect(updates).toHaveLength(0);
    });

    it('rejects a different verdict on a case that is already decided', async () => {
        const decided = lockedRow({
            investigation_status: 'decided', assigned_user_id: 3, verdict: 'not_confirmed',
            decision_reason: 'No damage found.', findings: 'The photos show an intact package.',
        });
        const { service, updates, outbox } = setup(decided);

        await expect(service.issueVerdict(12, verdictDto({ verdict: 'request_RMA' }), ACTOR)).rejects.toThrow(InvalidComplaintTransitionException);
        expect(updates).toHaveLength(0);
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it.each(['received', 'assigned'])('rejects a verdict on a case that is only %s', async (status) => {
        const { service, updates } = setup(lockedRow({ investigation_status: status, assigned_user_id: 3 }));

        await expect(service.issueVerdict(12, verdictDto(), ACTOR)).rejects.toThrow(InvalidComplaintTransitionException);
        expect(updates).toHaveLength(0);
    });

    it('rejects an old version', async () => {
        const { service, updates } = setup(investigating({ case_version: 2 }));

        await expect(service.issueVerdict(12, verdictDto({ expectedVersion: 1 }), ACTOR)).rejects.toThrow(ComplaintCaseVersionStaleException);
        expect(updates).toHaveLength(0);
    });

    it('rejects a verdict when the dispatch is not delivered, and never queues the request', async () => {
        const { service, updates, outbox } = setup(investigating({ dispatch_status: 'returned' }));

        await expect(service.issueVerdict(12, verdictDto({ verdict: 'request_RMA' }), ACTOR)).rejects.toThrow(ComplaintDispatchNotDeliveredException);
        expect(updates).toHaveLength(0);
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });
});
