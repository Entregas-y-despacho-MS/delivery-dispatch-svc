import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { FILTERS_SQL, FROM_TS, TO_TS, filterParams, type DeliveryPromiseFilters } from '../../delivery-promise/repositories/delivery-promise.sql.js';
import type { ComplaintCaseRow } from '../domain/case-quality.js';

/**
 * A reschedule changed the window only if it set a new one and it is not the one it had: a route reassignment has no new window
 * (`new_window_start` NULL), whatever it kept in `previous_window_*`, and a row that repeats the same window did not move anything.
 */
const WINDOW_CHANGED_SQL = `(r.new_window_start IS NOT NULL
        AND (r.new_window_start IS DISTINCT FROM r.previous_window_start OR r.new_window_end IS DISTINCT FROM r.previous_window_end))`;

/**
 * The delivery dispatches of the cohort of the promise (the end of their committed window; else their closing; else their creation,
 * as ST-301.3 places them) with one row per reschedule they had, `window_changed` NULL when they had none. Filters `$1`..`$5` are
 * those of `delivery-promise.sql.ts` (zone, status; `$4` is always NULL here). Nothing is built from user text.
 */
const PROMISE_COHORT_SQL = `
    SELECT d.dispatch_id, (s.name = '${DispatchStatusEnum.CANCELLED}') AS cancelled,
           CASE WHEN r.dispatch_reschedule_id IS NULL THEN NULL ELSE ${WINDOW_CHANGED_SQL} END AS window_changed
      FROM dispatches d
      JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
      JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
      LEFT JOIN dispatch_reschedules r ON r.dispatch_id = d.dispatch_id
     WHERE ${FILTERS_SQL}
       AND COALESCE(d.scheduled_window_end, d.closed_at, d.created_at) >= ${FROM_TS}
       AND COALESCE(d.scheduled_window_end, d.closed_at, d.created_at) < ${TO_TS}
     ORDER BY d.dispatch_id, r.dispatch_reschedule_id`;

/** The delivered dispatches closed inside the range (Bolivia days), with whether their window was ever changed. */
const DELIVERED_COHORT_SQL = `
    SELECT d.dispatch_id,
           EXISTS (SELECT 1 FROM dispatch_reschedules r WHERE r.dispatch_id = d.dispatch_id AND ${WINDOW_CHANGED_SQL}) AS rescheduled
      FROM dispatches d
      JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
      JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id AND s.name = '${DispatchStatusEnum.DELIVERED}'
     WHERE ${FILTERS_SQL}
       AND d.closed_at >= ${FROM_TS}
       AND d.closed_at < ${TO_TS}
     ORDER BY d.dispatch_id`;

const COMPLAINT_CASES_SQL = `
    SELECT delivery_complaint_case_id, dispatch_id, reason_code, investigation_status, opened_at, investigation_started_at, decided_at
      FROM delivery_complaint_cases
     WHERE dispatch_id = ANY($1::int[])
     ORDER BY delivery_complaint_case_id`;

const RATINGS_SQL = 'SELECT score FROM dispatch_ratings WHERE dispatch_id = ANY($1::int[]) ORDER BY dispatch_rating_id';

/** The incidents of the given dispatches that have this reason: their id is the key the attempts list them by. */
const INCIDENT_IDS_BY_REASON_SQL = `
    SELECT dispatch_incident_id::text AS id
      FROM dispatch_incidents
     WHERE incident_reason_id = $1::int AND dispatch_id = ANY($2::int[])`;

export interface PromiseCohortRow {
    dispatchId: number;
    cancelled: boolean;
    /** null: this row has no reschedule (the dispatch had none, or this is its only row). */
    windowChanged: boolean | null;
}

export interface DeliveredDispatchRow {
    dispatchId: number;
    rescheduled: boolean;
}

/** Reads the facts the quality indicators of ES-300 are computed from. The rules are in `domain/`; nothing here writes. */
@Injectable()
export class QualityRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async listPromiseCohort(filters: DeliveryPromiseFilters): Promise<PromiseCohortRow[]> {
        const rows: { dispatch_id: number; cancelled: boolean; window_changed: boolean | null }[] =
            await this.dataSource.query(PROMISE_COHORT_SQL, filterParams(filters, new Date()).slice(0, 5));
        return rows.map((row) => ({ dispatchId: row.dispatch_id, cancelled: row.cancelled, windowChanged: row.window_changed }));
    }

    async listDeliveredCohort(filters: DeliveryPromiseFilters): Promise<DeliveredDispatchRow[]> {
        const rows: { dispatch_id: number; rescheduled: boolean }[] =
            await this.dataSource.query(DELIVERED_COHORT_SQL, filterParams(filters, new Date()).slice(0, 5));
        return rows.map((row) => ({ dispatchId: row.dispatch_id, rescheduled: row.rescheduled }));
    }

    async listComplaintCases(dispatchIds: number[]): Promise<ComplaintCaseRow[]> {
        if (dispatchIds.length === 0) return [];
        const rows: {
            delivery_complaint_case_id: number; dispatch_id: number; reason_code: string; investigation_status: string;
            opened_at: Date; investigation_started_at: Date | null; decided_at: Date | null;
        }[] = await this.dataSource.query(COMPLAINT_CASES_SQL, [dispatchIds]);
        return rows.map((row) => ({
            caseId: row.delivery_complaint_case_id,
            dispatchId: row.dispatch_id,
            reasonCode: row.reason_code,
            investigationStatus: row.investigation_status,
            openedAt: new Date(row.opened_at),
            investigationStartedAt: row.investigation_started_at ? new Date(row.investigation_started_at) : null,
            decidedAt: row.decided_at ? new Date(row.decided_at) : null,
        }));
    }

    async listRatingScores(dispatchIds: number[]): Promise<number[]> {
        if (dispatchIds.length === 0) return [];
        const rows: { score: number }[] = await this.dataSource.query(RATINGS_SQL, [dispatchIds]);
        return rows.map((row) => Number(row.score));
    }

    async listIncidentIdsByReason(incidentReasonId: number, dispatchIds: number[]): Promise<Set<string>> {
        if (dispatchIds.length === 0) return new Set();
        const rows: { id: string }[] = await this.dataSource.query(INCIDENT_IDS_BY_REASON_SQL, [incidentReasonId, dispatchIds]);
        return new Set(rows.map((row) => row.id));
    }
}
