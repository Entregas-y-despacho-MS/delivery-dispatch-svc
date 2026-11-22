import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { buildEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { generateMessageId } from '../../../../plugins/messaging/envelope/uuid-v7.js';
import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import type { ComplaintAffectedItem } from '../../../messaging/complaint-intake/domain/complaint-message.types.js';
import type { ComplaintInvestigationStatus, ComplaintVerdict } from '../../../messaging/complaint-intake/entities/delivery-complaint-case.entity.js';
import { OutboxService } from '../../../messaging/outbound-messages/services/outbox.service.js';
import type { AssignComplaintCaseDto, IssueComplaintVerdictDto, StartComplaintInvestigationDto } from '../dto/complaint-case-commands.dto.js';
import type { ComplaintCaseDetailDto } from '../dto/complaint-case.dto.js';
import {
    ComplaintCaseNotFoundException,
    ComplaintCaseVersionStaleException,
    ComplaintDispatchNotDeliveredException,
    ComplaintOrderReferenceInvalidException,
    ComplaintReferenceNotCorrelatedException,
    InvalidComplaintAssigneeException,
    InvalidComplaintTransitionException,
} from '../exceptions/index.js';
import { RMA_AUTHORIZATION_REQUESTED_TOPIC } from '../utils/rma-authorization-message.js';
import { ComplaintCasesService } from './complaint-cases.service.js';

const DELIVERY_DISPATCH_TYPE = 'delivery';
const MAX_ORDER_REF_LENGTH = 64;

/** Roles that can be put in charge of a case; they are the ones that can operate the inbox. */
const ASSIGNABLE_ROLES: readonly string[] = [RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR];

interface LockedCaseRow {
    complaint_id: number;
    crm_case_id: string;
    case_version: number;
    tracking_code: string | null;
    reason_code: string;
    affected_items: ComplaintAffectedItem[];
    investigation_status: ComplaintInvestigationStatus;
    assigned_user_id: number | null;
    verdict: ComplaintVerdict | null;
    decision_reason: string | null;
    findings: string | null;
    dispatch_id: number;
    dispatch_type: string | null;
    dispatch_tracking_code: string | null;
    dispatch_status: string | null;
    source_order_ref: string | null;
}

/**
 * ST-45.2 (ES-45, RF-U22) — the three commands over a complaint case: assign, start the investigation and issue
 * the verdict. Each one runs in one transaction that locks the case row, so two concurrent commands never
 * overlap, and then answers with the case as it was committed.
 *
 * - **Version:** the command carries the `caseVersion` the person read; if CRM sent a newer one meanwhile it
 *   is rejected (409) before anything changes. That also covers a case CRM moved to another dispatch.
 * - **Idempotency:** repeating a command that already produced its result changes nothing and answers 200;
 *   an old version never reverts the verdict in force.
 * - **Transitions:** `received → assigned → in_investigation → decided`, checked here (the database only checks
 *   that each state is coherent). Only a case whose dispatch is `delivered` moves; the route batch is irrelevant.
 * - **RMA:** `request_RMA` stores the verdict and queues `dispatch.rma.authorization_requested` in the outbox
 *   within the same transaction. It creates no pickup: Inventory approves or rejects, and only then does one exist.
 */
@Injectable()
export class ComplaintCaseCommandsService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly outbox: OutboxService,
        private readonly cases: ComplaintCasesService,
    ) {}

    async assign(id: number, dto: AssignComplaintCaseDto, actorId: number): Promise<ComplaintCaseDetailDto> {
        const assigneeId = dto.assigneeUserId ?? actorId;
        await this.inTransaction(id, async (manager, row) => {
            if (row.investigation_status === 'assigned' && row.assigned_user_id === assigneeId) return; // repeated
            this.assertVersion(row, dto.expectedVersion);
            this.assertTransition('assign', row, ['received', 'assigned']);
            this.assertInvestigable(row);
            if (assigneeId !== actorId) await this.assertAssignable(manager, assigneeId);

            await manager.query(
                `UPDATE delivery_complaint_cases
                    SET investigation_status = 'assigned', assigned_user_id = $2, assigned_at = $3
                  WHERE delivery_complaint_case_id = $1`,
                [row.complaint_id, assigneeId, new Date()],
            );
        });
        return await this.cases.findOne(id);
    }

    async startInvestigation(id: number, dto: StartComplaintInvestigationDto): Promise<ComplaintCaseDetailDto> {
        await this.inTransaction(id, async (manager, row) => {
            if (row.investigation_status === 'in_investigation') return; // repeated
            this.assertVersion(row, dto.expectedVersion);
            this.assertTransition('start_investigation', row, ['assigned']);
            this.assertInvestigable(row);

            await manager.query(
                `UPDATE delivery_complaint_cases
                    SET investigation_status = 'in_investigation', investigation_started_at = $2
                  WHERE delivery_complaint_case_id = $1`,
                [row.complaint_id, new Date()],
            );
        });
        return await this.cases.findOne(id);
    }

    async issueVerdict(id: number, dto: IssueComplaintVerdictDto, actorId: number): Promise<ComplaintCaseDetailDto> {
        await this.inTransaction(id, async (manager, row) => {
            if (this.isSameVerdict(row, dto)) return; // repeated: an old version never reverts it either
            this.assertVersion(row, dto.expectedVersion);
            this.assertTransition('issue_verdict', row, ['in_investigation']);
            this.assertInvestigable(row);

            const now = new Date();
            // `authorizationRequestId` is the messageId of the request, so the answer from Inventory finds the case.
            const request = dto.verdict === 'request_RMA' ? this.buildAuthorizationRequest(row, dto, now) : null;
            await manager.query(
                `UPDATE delivery_complaint_cases
                    SET investigation_status = 'decided', verdict = $2, decision_reason = $3, findings = $4,
                        decided_by_user_id = $5, decided_at = $6, authorization_request_id = $7
                  WHERE delivery_complaint_case_id = $1`,
                [row.complaint_id, dto.verdict, dto.decisionReason, dto.findings, actorId, now, request?.messageId ?? null],
            );
            if (request) await this.outbox.enqueue(request, { manager });
        });
        return await this.cases.findOne(id);
    }

    private async inTransaction(id: number, work: (manager: EntityManager, row: LockedCaseRow) => Promise<void>): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const [row]: LockedCaseRow[] = await manager.query(
                `SELECT c.delivery_complaint_case_id AS complaint_id, c.crm_case_id, c.case_version, c.tracking_code,
                        c.reason_code, c.affected_items, c.investigation_status, c.assigned_user_id, c.verdict,
                        c.decision_reason, c.findings, c.dispatch_id, t.name AS dispatch_type,
                        d.tracking_code AS dispatch_tracking_code, s.name AS dispatch_status, d.source_order_ref
                   FROM delivery_complaint_cases c
                   LEFT JOIN dispatches d ON d.dispatch_id = c.dispatch_id
                   LEFT JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
                   LEFT JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
                  WHERE c.delivery_complaint_case_id = $1
                    FOR UPDATE OF c`,
                [id],
            );
            if (!row) throw new ComplaintCaseNotFoundException();
            await work(manager, row);
        });
    }

    private assertVersion(row: LockedCaseRow, expected: number): void {
        if (row.case_version !== expected) throw new ComplaintCaseVersionStaleException(expected, row.case_version);
    }

    private assertTransition(action: string, row: LockedCaseRow, allowedFrom: ComplaintInvestigationStatus[]): void {
        if (!allowedFrom.includes(row.investigation_status)) {
            throw new InvalidComplaintTransitionException(action, row.investigation_status);
        }
    }

    /** The case must name a delivery dispatch with the same tracking code, and that dispatch must be `delivered`. */
    private assertInvestigable(row: LockedCaseRow): void {
        const correlated = row.dispatch_type === DELIVERY_DISPATCH_TYPE
            && row.dispatch_tracking_code !== null
            && (row.tracking_code === null || row.tracking_code === row.dispatch_tracking_code);
        if (!correlated) throw new ComplaintReferenceNotCorrelatedException();
        if (row.dispatch_status !== DispatchStatusEnum.DELIVERED) throw new ComplaintDispatchNotDeliveredException();
    }

    private async assertAssignable(manager: EntityManager, userId: number): Promise<void> {
        const rows: { role: string }[] = await manager.query(
            `SELECT r.name AS role
               FROM users u
               JOIN roles r ON r.role_id = u.role_id
              WHERE u.user_id = $1 AND u.active AND u.deleted_at IS NULL`,
            [userId],
        );
        if (rows.length === 0 || !ASSIGNABLE_ROLES.includes(rows[0].role)) throw new InvalidComplaintAssigneeException();
    }

    private isSameVerdict(row: LockedCaseRow, dto: IssueComplaintVerdictDto): boolean {
        return row.investigation_status === 'decided'
            && row.verdict === dto.verdict
            && row.decision_reason === dto.decisionReason
            && row.findings === dto.findings;
    }

    private buildAuthorizationRequest(row: LockedCaseRow, dto: IssueComplaintVerdictDto, requestedAt: Date) {
        // The contract caps the order id at 64 characters while the column allows 100: answer 422 instead of failing in the outbox.
        if (!row.source_order_ref || row.source_order_ref.length > MAX_ORDER_REF_LENGTH) throw new ComplaintOrderReferenceInvalidException();
        const messageId = generateMessageId();
        return buildEnvelope({
            type: RMA_AUTHORIZATION_REQUESTED_TOPIC,
            source: 'dispatch',
            occurredAt: requestedAt,
            messageId,
            data: {
                authorizationRequestId: messageId,
                crmCaseId: row.crm_case_id,
                caseVersion: row.case_version,
                dispatchId: row.dispatch_id,
                trackingCode: row.dispatch_tracking_code,
                salesOrderId: row.source_order_ref,
                reasonCode: row.reason_code,
                decisionReason: dto.decisionReason,
                affectedItems: row.affected_items,
                requestedAt: requestedAt.toISOString(),
            },
        });
    }
}
