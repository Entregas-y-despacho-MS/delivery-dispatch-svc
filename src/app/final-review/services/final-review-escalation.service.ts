import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { PlanningAlertsService } from '../../planning/services/planning-alerts.service.js';
import type { ScheduledTaskContext } from '../../scheduler/ports/scheduled-task.js';
import {
    loadFinalReviewSettings,
    MILESTONE_BATCH_STATUSES,
    shiftDateOfMilestone,
} from '../domain/final-review-timeline.js';
import { FINAL_REVIEW_ESCALATED_EVENT } from '../final-review-events.js';
import { CustomerNoticeService } from './customer-notice.service.js';
import { FinalReviewRepository } from './final-review.repository.js';

export const COORDINATOR_TASK_REQUIRED_EVENT = 'coordinator_task_required';

export interface FinalReviewEscalationSummary {
    status: 'executed' | 'blocked' | 'not_escalation_day';
    shiftDate: string | null;
    escalatedBatchIds: number[];
    /** Batches that already had their escalation in an earlier run. */
    alreadyEscalatedBatchIds: number[];
    /** Batches with no order the customer was promised: nothing to protect. */
    withoutPromisedOrdersBatchIds: number[];
    incidentsRegistered: number;
    riskNoticesSent: number;
    /** Risk notices that bounced or failed (a coordinator follow-up was opened). */
    riskNoticesFailed: number;
}

const ESCALATABLE = MILESTONE_BATCH_STATUSES.escalation;

/**
 * `final_review_escalation_time` of the route day (ST-51.4, D-46): a batch that is still not approved is
 * treated as case 5.2 (the company does not comply). It does **not** approve anything and does **not**
 * move any order: the original day and window stay.
 *
 * For each batch (`pending_final_review`, or a remnant of the cutoff still `provisional`):
 * - every order whose promise the customer already received gets an `INC-COMP-FAILURE` incident (it does
 *   not consume a delivery attempt) and a risk notice;
 * - the batch gets the event `final_review_escalated`, a `coordinator_task_required` event (the task of
 *   the coordinator) and the alert `final_review_escalated`.
 *
 * Idempotent by data: each order is escalated once (its event is written in the same transaction as the
 * incident) and the batch is marked last, so a run that died half-way finishes on the next one.
 */
@Injectable()
export class FinalReviewEscalationService {
    private readonly logger = new Logger(FinalReviewEscalationService.name);

    constructor(
        private readonly settings: SettingsService,
        private readonly repository: FinalReviewRepository,
        private readonly notices: CustomerNoticeService,
        private readonly alerts: PlanningAlertsService,
    ) {}

    async run(context: ScheduledTaskContext): Promise<FinalReviewEscalationSummary> {
        const summary: FinalReviewEscalationSummary = {
            status: 'executed', shiftDate: null, escalatedBatchIds: [], alreadyEscalatedBatchIds: [],
            withoutPromisedOrdersBatchIds: [], incidentsRegistered: 0, riskNoticesSent: 0, riskNoticesFailed: 0,
        };

        const loaded = await loadFinalReviewSettings(this.settings);
        if (!loaded.ok) {
            await this.alerts.raise('settings_missing', { missingKeys: loaded.missingKeys, invalidKeys: loaded.invalidKeys });
            return { ...summary, status: 'blocked' };
        }
        const settings = loaded.values!;

        const shiftDate = shiftDateOfMilestone('escalation', context.startedAt, settings.calendar);
        if (!shiftDate) return { ...summary, status: 'not_escalation_day' };
        summary.shiftDate = shiftDate;

        const reasonId = await this.repository.findCompanyFailureReasonId();
        if (reasonId === null) this.logger.error('Incident reason INC-COMP-FAILURE is not seeded: case 5.2 incidents are skipped.');

        for (const batch of await this.repository.findBatches(shiftDate, ESCALATABLE)) {
            const orders = await this.repository.findEscalationDispatches(batch.routeBatchId);
            if (orders.length === 0) {
                summary.withoutPromisedOrdersBatchIds.push(batch.routeBatchId);
                continue;
            }

            let incidents = 0;
            let noticesSent = 0;
            let noticesFailed = 0;
            for (const order of orders) {
                if (reasonId !== null && !order.escalated) {
                    const incidentId = await this.repository.registerCompanyFailure(order.dispatchId, reasonId, {
                        routeBatchId: batch.routeBatchId, batchStatus: batch.status, shiftDate,
                    });
                    if (incidentId) incidents += 1;
                }
                const outcome = await this.notices.sendRiskNotice(batch.routeBatchId, order);
                if (outcome === 'sent') noticesSent += 1;
                if (outcome === 'failed') noticesFailed += 1;
            }
            summary.incidentsRegistered += incidents;
            summary.riskNoticesSent += noticesSent;
            summary.riskNoticesFailed += noticesFailed;

            const detail = {
                routeBatchId: batch.routeBatchId,
                shiftDate,
                batchStatus: batch.status,
                remnant: batch.status === 'provisional',
                promisedOrders: orders.length,
                incidentsRegistered: incidents,
                riskNoticesSent: noticesSent,
                riskNoticesFailed: noticesFailed,
                finalReviewEscalationTime: settings.finalReviewEscalationTime,
            };
            const wrote = await this.repository.recordBatchEventOnce(
                batch.routeBatchId, FINAL_REVIEW_ESCALATED_EVENT, ESCALATABLE,
                'Batch not approved at final_review_escalation_time; handled as case 5.2', detail,
            );
            if (!wrote) {
                summary.alreadyEscalatedBatchIds.push(batch.routeBatchId);
                continue;
            }
            await this.repository.recordBatchEventOnce(
                batch.routeBatchId, COORDINATOR_TASK_REQUIRED_EVENT, ESCALATABLE,
                'Coordinator must approve or resolve this batch; no automatic approval exists', detail,
            );
            await this.alerts.raise('final_review_escalated', detail);
            summary.escalatedBatchIds.push(batch.routeBatchId);
        }
        return summary;
    }
}
