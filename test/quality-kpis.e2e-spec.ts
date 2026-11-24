// ST-300.1 — Real PostgreSQL checks for the quality indicators of ES-300 (Dashboard 4). QualityKpisService has no endpoint yet (the next
// subtask), so the suite boots the real AppModule and calls the service: the SQL, the attempt rule of ST-301.3 and the formulas run for real.
// Every expected figure of the reference case is recomputed by hand in the comments.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { QualityKpisService } from '../src/app/quality-kpis/services/quality-kpis.service.js';
import { KpiUnavailableReason } from '../src/app/quality-kpis/domain/kpi.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

// March 2020: the past, so every promise has expired and no other suite writes there. Bolivia is UTC-4: 14:00-16:00 there is 18:00Z-20:00Z.
const win = (day: string): [string, string] => [`2020-03-${day}T18:00:00Z`, `2020-03-${day}T20:00:00Z`];
const at = (day: string, time: string) => `2020-03-${day}T${time}:00Z`;
const COVERED = { from: '2020-03-05', to: '2020-03-31' };
const NOT_COVERED = { from: '2020-03-01', to: '2020-03-31' };
const AUTHORIZED = { ratingsAuthorized: true };

describe('quality indicators of Dashboard 4 (e2e, ST-300.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let service: QualityKpisService;
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST3001-${run}`;
    const zone = { MAIN: 0, OTHER: 0, EMPTY: 0 };
    const dispatchOf: Record<number, number> = {};
    const statusIds: Record<string, number> = {};
    const reasonIds: Record<string, number> = {};
    let deliveryTypeId = 0;
    let rescheduleReasonId = 0;
    let userId = 0;
    let routeBatchId = 0;

    const insertDispatch = async (n: number, status: string, window: [string, string] | null, options: { closedAt?: string; zoneId?: number } = {}) => {
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, source_order_ref, delivery_address, closed_at, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, 'Dirección E2E ST-300.1', $5, $6, $7) RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], options.zoneId ?? zone.MAIN, `${prefix}-${n}`, options.closedAt ?? null, window?.[0] ?? null, window?.[1] ?? null],
        );
        dispatchOf[n] = id;
    };

    /** A `status_changed` event as the backend writes it: new status, previous status and author. */
    const event = async (n: number, status: string, previous: string, createdAt: string, options: { clientEventId?: string; reason?: string } = {}) => {
        await dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, client_event_id, actor_type, reason, metadata, created_at)
             VALUES ($1, 'status_changed', $2, 'user', $3, $4::jsonb, $5)`,
            [dispatchOf[n], options.clientEventId ?? null, options.reason ?? null, JSON.stringify({ previousStatus: previous, status, ...(options.reason ? { reasonCode: options.reason } : {}) }), createdAt],
        );
    };

    /** An incident as the driver app reports it: the `dispatch_incidents` row and the event share the id. */
    const incident = async (n: number, reason: string, createdAt: string): Promise<string> => {
        const id = randomUUID();
        await dataSource.query(`INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id) VALUES ($1, $2, $3)`, [id, dispatchOf[n], reasonIds[reason]]);
        await event(n, 'incident', 'in_transit', createdAt, { clientEventId: id, reason });
        return id;
    };

    const reschedule = (n: number, previous: [string, string] | null, next: [string, string] | null, newRouteBatchId: number | null = null) =>
        dataSource.query(
            `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by_type, previous_window_start, previous_window_end, new_window_start, new_window_end, new_route_batch_id)
             VALUES ($1, $2, 'system', $3, $4, $5, $6, $7)`,
            [dispatchOf[n], rescheduleReasonId, previous?.[0] ?? null, previous?.[1] ?? null, next?.[0] ?? null, next?.[1] ?? null, newRouteBatchId],
        );

    const complaintCase = (n: number, key: string, options: { startedAt?: string; decidedAt?: string; openedAt?: string } = {}) =>
        dataSource.query(
            `INSERT INTO delivery_complaint_cases
                (message_id, source, crm_case_id, case_version, dispatch_id, reason_code, affected_items, opened_at, consumed_at, intake_status, acknowledged_at,
                 investigation_status, assigned_user_id, assigned_at, investigation_started_at, verdict, decision_reason, decided_by_user_id, decided_at)
             VALUES (gen_random_uuid(), 'crm', $1, 1, $2, 'DAMAGED', '[{"itemCode":"SKU-1","quantity":1}]'::jsonb, $3, $3, 'acknowledged', $3,
                     $4, $5, $6, $7, $8, $9, $10, $11)`,
            options.decidedAt
                ? [`${prefix}-${key}`, dispatchOf[n], options.openedAt ?? options.startedAt, 'decided', userId, options.startedAt, options.startedAt, 'not_confirmed', 'Seeded reason.', userId, options.decidedAt]
                : [`${prefix}-${key}`, dispatchOf[n], options.openedAt, 'received', null, null, null, null, null, null, null],
        );

    const rating = (n: number, score: number) => dataSource.query(`INSERT INTO dispatch_ratings (dispatch_id, score) VALUES ($1, $2)`, [dispatchOf[n], score]);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        await app.init();
        dataSource = moduleRef.get(DataSource);
        service = moduleRef.get(QualityKpisService, { strict: false });

        const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = 'coordinator'`);
        [{ user_id: userId }] = await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
            [roleId, `ST-300.1 coordinator ${run}`, `e2e_st3001_coordinator_${run}`, await hashPassword('E2eTest1234')],
        );
        for (const key of ['MAIN', 'OTHER', 'EMPTY'] as const) {
            const [{ delivery_zone_id: id }] = await dataSource.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`, [`Z3001${run}${key}`, `E2E3001 ${run} ${key}`]);
            zone[key] = id;
        }
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        for (const row of await dataSource.query(`SELECT incident_reason_id, code FROM incident_reasons`)) reasonIds[row.code] = row.incident_reason_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        [{ reschedule_reason_id: rescheduleReasonId }] = await dataSource.query(`SELECT reschedule_reason_id FROM reschedule_reasons WHERE code = 'RES-CLI-SELF'`);
        [{ route_batch_id: routeBatchId }] = await dataSource.query(`INSERT INTO route_batches (status, shift_date) VALUES ('provisional', '2020-03-10') RETURNING route_batch_id`);

        // 11: before the range. Its trip (March 2) is the first one the backend wrote: the instrumented period starts there.
        await insertDispatch(11, 'delivered', win('02'), { closedAt: at('02', '19:00') });
        await event(11, 'in_transit', 'out_for_delivery', at('02', '17:00'));
        await event(11, 'delivered', 'in_transit', at('02', '19:00'));

        // 1: attempt 1 ends in an incident reported TWICE (same attempt), attempt 2 delivered. Window changed twice.
        await insertDispatch(1, 'delivered', win('10'), { closedAt: at('10', '19:00') });
        await event(1, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await incident(1, 'INC-CUST-ABSENT', at('10', '17:30'));
        await incident(1, 'INC-CUST-ABSENT', at('10', '17:31'));
        await event(1, 'in_transit', 'incident', at('10', '18:00'));
        await event(1, 'delivered', 'in_transit', at('10', '19:00'));
        await reschedule(1, win('09'), win('10'));
        await reschedule(1, win('08'), win('09'));

        // 2: one attempt, delivered. Window changed once.
        await insertDispatch(2, 'delivered', win('10'), { closedAt: at('10', '19:00') });
        await event(2, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(2, 'delivered', 'in_transit', at('10', '19:00'));
        await reschedule(2, win('09'), win('10'));

        // 3: a not_delivered and the incident that caused it: ONE attempt, with an incident. Still open.
        await insertDispatch(3, 'incident', win('11'));
        await event(3, 'in_transit', 'out_for_delivery', at('11', '17:00'));
        await event(3, 'not_delivered', 'in_transit', at('11', '18:00'));
        await incident(3, 'INC-CUST-ABSENT', at('11', '18:01'));

        // 4: delivered, a decided case (60 min) and a rating of 5.  5: delivered, a decided case (120 min) and a rating of 3.
        await insertDispatch(4, 'delivered', win('12'), { closedAt: at('12', '19:00') });
        await event(4, 'in_transit', 'out_for_delivery', at('12', '17:00'));
        await event(4, 'delivered', 'in_transit', at('12', '19:00'));
        await complaintCase(4, 'case-4', { startedAt: at('13', '10:00'), decidedAt: at('13', '11:00') });
        await rating(4, 5);
        await insertDispatch(5, 'delivered', win('12'), { closedAt: at('12', '19:00') });
        await event(5, 'in_transit', 'out_for_delivery', at('12', '17:00'));
        await event(5, 'delivered', 'in_transit', at('12', '19:00'));
        await complaintCase(5, 'case-5', { startedAt: at('13', '10:00'), decidedAt: at('13', '12:00') });
        await rating(5, 3);

        // 6: delivered, a case still open (no start, no decision), no rating.
        await insertDispatch(6, 'delivered', win('13'), { closedAt: at('13', '19:00') });
        await event(6, 'in_transit', 'out_for_delivery', at('13', '17:00'));
        await event(6, 'delivered', 'in_transit', at('13', '19:00'));
        await complaintCase(6, 'case-6', { openedAt: at('14', '10:00') });

        // 7: an incident whose reason does NOT consume an attempt (not an attempt, not in the rate), then delivered. Two rows that moved no window:
        // a route reassignment (no new window, whatever it kept as previous) and a row that repeated the same window.
        await insertDispatch(7, 'delivered', win('13'), { closedAt: at('13', '19:00') });
        await event(7, 'in_transit', 'out_for_delivery', at('13', '17:00'));
        await incident(7, 'INC-PROD-DAMAGED', at('13', '17:30'));
        await event(7, 'in_transit', 'incident', at('13', '17:40'));
        await event(7, 'delivered', 'in_transit', at('13', '19:00'));
        await reschedule(7, win('13'), null, routeBatchId);
        await reschedule(7, win('13'), win('13'));

        // 8: cancelled with a window change: not an eligible dispatch, its reschedule is not counted.
        await insertDispatch(8, 'cancelled', win('10'));
        await reschedule(8, win('09'), win('10'));

        // 9: other zone, delivered, one attempt, no incident, never rescheduled.
        await insertDispatch(9, 'delivered', win('10'), { closedAt: at('10', '19:00'), zoneId: zone.OTHER });
        await event(9, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(9, 'delivered', 'in_transit', at('10', '19:00'));

        // 10: delivered with no event at all (history from before the instrumentation): it cannot be rebuilt.
        await insertDispatch(10, 'delivered', win('14'), { closedAt: at('14', '19:00') });
    });

    afterAll(async () => {
        if (!dataSource) return;
        try {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: [routeBatchId], userNames: [`e2e_st3001_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM delivery_complaint_cases WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`${prefix}%`]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = $1`, [routeBatchId]);
                await manager.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`Z3001${run}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st3001_%_${run}`]);
            });
        } finally {
            await app?.close();
        }
    });

    it('recomputes the reference case by hand over the whole period', async () => {
        const report = await service.getQualityKpis(COVERED, AUTHORIZED);
        const { incidentRate, rescheduleRate, complaintRate, investigationTime, ratingAverage, responseRate } = report.kpis;

        // Attempts: d1 2, d2 1, d3 1, d4 1, d5 1, d6 1, d7 1, d9 1 = 9 (d10 cannot be rebuilt). With an incident: d1 attempt 1 (reported twice), d3 = 2. 2/9 = 22.2.
        expect(report.details.attempts).toEqual({
            attemptCount: 9, attemptsWithIncidentCount: 2, dispatchesWithIncidentCount: 2, incidentEventCount: 3, incidentsWithoutAttemptCount: 1, notReconstructableCount: 1,
        });
        expect(incidentRate).toMatchObject({ numerator: 2, denominator: 9, n: 9, value: 22.2, available: true, reason: null });

        // Eligible (not cancelled): d1..d7, d9, d10 = 9. Window changed: d1 and d2 = 2 → 22.2. Events: 3 (d1 twice, d2 once). d7's two rows moved no window.
        expect(report.details.reschedules).toEqual({ rescheduledDispatchCount: 2, rescheduleEventCount: 3, reassignmentOnlyCount: 2, eligibleDispatchCount: 9 });
        expect(rescheduleRate).toMatchObject({ numerator: 2, denominator: 9, n: 9, value: 22.2 });

        // Delivered and closed in the period: d1, d2, d4, d5, d6, d7, d9, d10 = 8. Cases: d4, d5, d6 = 3 → 37.5.
        expect(report.details.complaints).toMatchObject({ caseCount: 3, dispatchesWithCaseCount: 3, deliveredDispatchCount: 8, decidedWithoutTimestampsCount: 0 });
        expect(complaintRate).toMatchObject({ numerator: 3, denominator: 8, n: 8, value: 37.5 });

        // Median of (60, 120) = 90 minutes, n = 2. The open case is a count with its age, outside the median.
        expect(investigationTime).toMatchObject({ value: 90, n: 2, available: true });
        expect(report.details.complaints.open.count).toBe(1);
        expect(report.details.complaints.open.oldestAgeMinutes).toBeGreaterThan(0);

        // Ratings (5, 3) → 4, n = 2. The response rate cannot be told: nothing records who was invited to answer.
        expect(ratingAverage).toMatchObject({ value: 4, n: 2, available: true });
        expect(responseRate).toMatchObject({ available: false, value: null, reason: KpiUnavailableReason.RESPONSE_OPPORTUNITY_NOT_RECORDED });
        expect(report.details.attemptCoverage.complete).toBe(true);
    });

    it('omits the rating, with no figure, when the caller may not read it', async () => {
        const report = await service.getQualityKpis(COVERED, { ratingsAuthorized: false });
        expect(report.kpis.ratingAverage).toMatchObject({ available: false, value: null, n: 0, numerator: null, reason: KpiUnavailableReason.RATING_NOT_AUTHORIZED });
        expect(report.kpis.complaintRate.value).toBe(37.5);
    });

    it('is N/D with its cause, keeping the counts, when the range starts before the instrumented period', async () => {
        const report = await service.getQualityKpis(NOT_COVERED, AUTHORIZED);
        expect(report.details.attemptCoverage.complete).toBe(false);
        expect(report.kpis.incidentRate).toMatchObject({ available: false, value: null, reason: KpiUnavailableReason.ATTEMPT_COVERAGE_INCOMPLETE });
        expect(report.kpis.incidentRate.denominator).toBeGreaterThan(0);
        expect(report.kpis.rescheduleRate.available).toBe(true);
    });

    it('zone filter changes every indicator: the other zone has 1 attempt, no incident (a real 0), no reschedule, 1 delivery and no case', async () => {
        const main = await service.getQualityKpis({ ...COVERED, zoneId: zone.MAIN }, AUTHORIZED);
        // 8 attempts, 2 with incident → 25. Delivered: 7, cases 3 → 42.9.
        expect(main.kpis.incidentRate).toMatchObject({ numerator: 2, denominator: 8, value: 25 });
        expect(main.kpis.complaintRate).toMatchObject({ numerator: 3, denominator: 7, value: 42.9 });

        const other = await service.getQualityKpis({ ...COVERED, zoneId: zone.OTHER }, AUTHORIZED);
        expect(other.kpis.incidentRate).toMatchObject({ numerator: 0, denominator: 1, value: 0, available: true });
        expect(other.kpis.rescheduleRate).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
        expect(other.kpis.complaintRate).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
        expect(other.kpis.ratingAverage).toMatchObject({ value: null, n: 0, available: true });
    });

    it('a zone with nothing in it is Sin datos everywhere, never a 0', async () => {
        const report = await service.getQualityKpis({ ...COVERED, zoneId: zone.EMPTY }, AUTHORIZED);
        for (const kpi of [report.kpis.incidentRate, report.kpis.rescheduleRate, report.kpis.complaintRate, report.kpis.investigationTime, report.kpis.ratingAverage]) {
            expect(kpi).toMatchObject({ available: true, value: null });
        }
        expect(report.details.complaints.open).toEqual({ count: 0, oldestAgeMinutes: null });
    });

    it('«motivo» filter narrows the numerator and leaves the denominator: 9 attempts', async () => {
        const absent = await service.getQualityKpis({ ...COVERED, incidentReasonId: reasonIds['INC-CUST-ABSENT'] }, AUTHORIZED);
        expect(absent.kpis.incidentRate).toMatchObject({ numerator: 2, denominator: 9, value: 22.2 });
        expect(absent.details.attempts.incidentsWithoutAttemptCount).toBe(0);

        // The damaged-product incident of d7 does not consume an attempt: no attempt carries it, the rate is a real 0 and it is counted apart.
        const damaged = await service.getQualityKpis({ ...COVERED, incidentReasonId: reasonIds['INC-PROD-DAMAGED'] }, AUTHORIZED);
        expect(damaged.kpis.incidentRate).toMatchObject({ numerator: 0, denominator: 9, value: 0 });
        expect(damaged.details.attempts.incidentsWithoutAttemptCount).toBe(1);
    });

    it('«reprogramación» filter applies to every indicator', async () => {
        // d1 (2 attempts, 1 with incident) and d2 (1 attempt): 3 attempts, 1 with incident → 33.3. Both rescheduled → 100. Delivered: d1, d2, no case.
        const yes = await service.getQualityKpis({ ...COVERED, rescheduled: true }, AUTHORIZED);
        expect(yes.kpis.incidentRate).toMatchObject({ numerator: 1, denominator: 3, value: 33.3 });
        expect(yes.kpis.rescheduleRate).toMatchObject({ numerator: 2, denominator: 2, value: 100 });
        expect(yes.kpis.complaintRate).toMatchObject({ numerator: 0, denominator: 2, value: 0 });

        // The other 7 eligible dispatches: none changed its window → a real 0 over 7 (d7's two rows moved no window). d8 is cancelled.
        const no = await service.getQualityKpis({ ...COVERED, rescheduled: false }, AUTHORIZED);
        expect(no.kpis.rescheduleRate).toMatchObject({ numerator: 0, denominator: 7, value: 0 });
        expect(no.kpis.complaintRate).toMatchObject({ numerator: 3, denominator: 6 });
    });

    it('status filter works on the current status: delivered leaves out the open incident of d3', async () => {
        const report = await service.getQualityKpis({ ...COVERED, status: 'delivered' }, AUTHORIZED);
        // d1 2, d2 1, d4 1, d5 1, d6 1, d7 1, d9 1 = 8 attempts; d1's attempt 1 has the incident → 1/8 = 12.5.
        expect(report.kpis.incidentRate).toMatchObject({ numerator: 1, denominator: 8, value: 12.5 });
    });
});
