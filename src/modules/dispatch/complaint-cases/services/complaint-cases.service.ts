import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';
import type { ComplaintAffectedItem } from '../../../messaging/complaint-intake/domain/complaint-message.types.js';
import type { ComplaintInvestigationStatus, ComplaintVerdict } from '../../../messaging/complaint-intake/entities/delivery-complaint-case.entity.js';
import { ComplaintCaseDetailDto, ComplaintCaseItemDto, FindComplaintCasesResponseDto } from '../dto/complaint-case.dto.js';
import type { FindComplaintCasesParamsDto } from '../dto/find-complaint-cases-params.dto.js';
import { ComplaintCaseNotFoundException } from '../exceptions/index.js';
import { buildComplaintCasesQuery, COMPLAINT_CASES_FROM_SQL } from '../utils/complaint-cases-query.js';
import { isAuthorizationPending, nextActionOf } from '../utils/next-action.js';

interface ComplaintCaseRow {
    complaint_id: number;
    crm_case_id: string;
    dispatch_id: number;
    tracking_code: string | null;
    case_version: number;
    reason_code: string;
    investigation_status: ComplaintInvestigationStatus;
    dispatch_status: string;
    zone_id: number | null;
    zone_name: string | null;
    assigned_user_id: number | null;
    assigned_user_name: string | null;
    verdict: ComplaintVerdict | null;
    rma_id: string | null;
    received_at: Date;
    opened_at: Date;
    assigned_at: Date | null;
    decided_at: Date | null;
    updated_at: Date;
}

interface ComplaintCaseDetailRow extends ComplaintCaseRow {
    investigation_started_at: Date | null;
    findings: string | null;
    decision_reason: string | null;
    decided_by_user_id: number | null;
    decided_by_user_name: string | null;
    authorization_request_id: string | null;
    affected_items: ComplaintAffectedItem[];
    route_batch_id: number | null;
    route_batch_status: string | null;
}

const ITEM_SELECT_SQL = `SELECT c.delivery_complaint_case_id AS complaint_id, c.crm_case_id, c.dispatch_id,
        d.tracking_code, c.case_version, c.reason_code, c.investigation_status, s.name AS dispatch_status,
        d.delivery_zone_id AS zone_id, z.name AS zone_name, c.assigned_user_id, au.full_name AS assigned_user_name,
        c.verdict, c.rma_id, c.consumed_at AS received_at, c.opened_at, c.assigned_at, c.decided_at, c.updated_at`;

const DETAIL_SELECT_SQL = `${ITEM_SELECT_SQL},
        c.investigation_started_at, c.findings, c.decision_reason, c.decided_by_user_id, du.full_name AS decided_by_user_name,
        c.authorization_request_id, c.affected_items, d.route_batch_id, rb.status AS route_batch_status`;

/**
 * ST-45.2 (ES-45, RF-U22) — inbox and detail of the complaint cases. Read side only: it joins the case with its
 * dispatch, zone and route batch through the DataSource, so one SQL answers the page. A case is readable while its
 * route batch is still `in_execution`: what makes it eligible is the dispatch being `delivered`, not the batch.
 */
@Injectable()
export class ComplaintCasesService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findAll(params: FindComplaintCasesParamsDto): Promise<FindComplaintCasesResponseDto> {
        const { page, limit } = params;
        const { whereSql, args, bind } = buildComplaintCasesQuery(params);

        const [{ total }]: { total: number }[] = await this.dataSource.query(
            `SELECT COUNT(*)::int AS total ${COMPLAINT_CASES_FROM_SQL} ${whereSql}`,
            args,
        );
        // Most recently received first; the id keeps a page from repeating or skipping a row when the time ties.
        const rows: ComplaintCaseRow[] = await this.dataSource.query(
            `${ITEM_SELECT_SQL} ${COMPLAINT_CASES_FROM_SQL} ${whereSql}
             ORDER BY c.consumed_at DESC, c.delivery_complaint_case_id DESC
             LIMIT ${bind(limit)} OFFSET ${bind((page - 1) * limit)}`,
            args,
        );
        return {
            data: rows.map((row) => this.toItemDto(row)),
            meta: { page, limit, total, pages: Math.ceil(total / limit) },
        };
    }

    async findOne(complaintId: number): Promise<ComplaintCaseDetailDto> {
        const [row]: ComplaintCaseDetailRow[] = await this.dataSource.query(
            `${DETAIL_SELECT_SQL} ${COMPLAINT_CASES_FROM_SQL} WHERE c.delivery_complaint_case_id = $1`,
            [complaintId],
        );
        if (!row) throw new ComplaintCaseNotFoundException();
        return {
            ...this.toItemDto(row),
            investigationStartedAt: row.investigation_started_at,
            findings: row.findings,
            decisionReason: row.decision_reason,
            decidedByUserId: row.decided_by_user_id,
            decidedByUserName: row.decided_by_user_name,
            authorizationRequestId: row.authorization_request_id,
            rmaId: row.rma_id,
            affectedItems: row.affected_items ?? [],
            routeBatchId: row.route_batch_id,
            routeBatchStatus: row.route_batch_status,
        };
    }

    private toItemDto(row: ComplaintCaseRow): ComplaintCaseItemDto {
        const eligible = row.dispatch_status === DispatchStatusEnum.DELIVERED;
        return {
            complaintId: row.complaint_id,
            crmCaseId: row.crm_case_id,
            dispatchId: row.dispatch_id,
            trackingCode: row.tracking_code,
            caseVersion: row.case_version,
            reasonCode: row.reason_code,
            investigationStatus: row.investigation_status,
            nextAction: nextActionOf({ investigationStatus: row.investigation_status, verdict: row.verdict, rmaId: row.rma_id, eligible }),
            eligible,
            dispatchStatus: row.dispatch_status,
            zoneId: row.zone_id,
            zoneName: row.zone_name,
            assignedUserId: row.assigned_user_id,
            assignedUserName: row.assigned_user_name,
            verdict: row.verdict,
            authorizationPending: isAuthorizationPending(row.verdict, row.rma_id),
            receivedAt: row.received_at,
            openedAt: row.opened_at,
            assignedAt: row.assigned_at,
            decidedAt: row.decided_at,
            updatedAt: row.updated_at,
        };
    }
}
