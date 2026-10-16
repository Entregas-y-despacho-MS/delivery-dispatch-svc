import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import type { PlanningAlertEvent } from '../../planning/services/planning-alerts.service.js';
import { PlanningAlertsService } from '../../planning/services/planning-alerts.service.js';
import type { ScheduledTaskContext } from '../../scheduler/ports/scheduled-task.js';
import { nearestMinute } from '../../scheduler/domain/task-schedule.js';
import {
    loadFinalReviewSettings,
    MILESTONE_BATCH_STATUSES,
    shiftDateOfMilestone,
} from '../domain/final-review-timeline.js';
import {
    COORDINATOR_TASK_REQUIRED_EVENT,
    FINAL_REVIEW_ESCALATED_EVENT,
    RISK_NOTICE_SENT_EVENT,
} from '../final-review-events.js';
import { CustomerNoticeService } from './customer-notice.service.js';
import { FinalReviewRepository, type DispatchNoticeState } from './final-review.repository.js';

export interface FinalReviewEscalationSummary {
    status: 'executed' | 'blocked' | 'not_escalation_day';
    shiftDate: string | null;
    escalatedBatchIds: number[];
    /** Batches that already had their escalation in an earlier run. */
    alreadyEscalatedBatchIds: number[];
    /** Batches approved while the run was working: nothing more is done for them. */
    approvedMeanwhileBatchIds: number[];
    /** Batches with no order the customer was promised: nothing to protect. */
    withoutPromisedOrdersBatchIds: number[];
    /** Batches whose closing step failed; the next run finishes them. */
    failedBatchIds: number[];
    incidentsRegistered: number;
    riskNoticesSent: number;
    /** Risk notices that bounced or failed (a coordinator follow-up was opened). */
    riskNoticesFailed: number;
}

const ESCALATABLE = MILESTONE_BATCH_STATUSES.escalation;

type Step = { kind: 'batch_changed' | 'skip' } | { kind: 'done'; incident: boolean; send: DispatchNoticeState | null };
type Closing = { kind: 'not_pending' | 'already' } | { kind: 'escalated'; event: PlanningAlertEvent };

/**
 * `final_review_escalation_time` of the route day (ST-51.4, D-46): a batch that is still not approved is
 * treated as case 5.2 (the company does not comply). It does **not** approve anything and does **not**
 * move any order: the original day and window stay.
 *
 * For each batch (`pending_final_review`, or a remnant of the cutoff still `provisional`):
 * - every order whose promise the customer already received gets an `INC-COMP-FAILURE` incident (it does
 *   not consume a delivery attempt) and a risk notice;
 * - last, the batch gets the event `final_review_escalated`, the `coordinator_task_required` event (the
 *   task of the coordinator) and the alert `final_review_escalated`, all in one transaction.
 *
 * Every step runs under the lock of the batch and re-checks that it is still unapproved, so an approval
 * that lands during the run stops it: no incident or risk notice is written for an order that is already
 * `assigned`. Idempotent: each order is escalated once per batch and the batch is marked last, so a run
 * that died half-way finishes on the next one without repeating anything.
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
            approvedMeanwhileBatchIds: [], withoutPromisedOrdersBatchIds: [], failedBatchIds: [],
            incidentsRegistered: 0, riskNoticesSent: 0, riskNoticesFailed: 0,
        };

        const loaded = await loadFinalReviewSettings(this.settings);
        if (!loaded.ok) {
            await this.alerts.raise('settings_missing', { missingKeys: loaded.missingKeys, invalidKeys: loaded.invalidKeys });
            return { ...summary, status: 'blocked' };
        }
        const settings = loaded.values!;

        const shiftDate = shiftDateOfMilestone('escalation', nearestMinute(context.startedAt), settings.calendar);
        if (!shiftDate) return { ...summary, status: 'not_escalation_day' };
        summary.shiftDate = shiftDate;

        const reasonId = await this.repository.findCompanyFailureReasonId();
        if (reasonId === null) this.logger.error('Incident reason INC-COMP-FAILURE is not seeded: case 5.2 incidents are skipped.');

        for (const batch of await this.repository.findBatches(shiftDate, ESCALATABLE)) {
            try {
                await this.escalateBatch(batch.routeBatchId, batch.status, shiftDate, settings.finalReviewEscalationTime, reasonId, summary);
            } catch (error) {
                summary.failedBatchIds.push(batch.routeBatchId);
                this.logger.error(`Escalation of batch ${batch.routeBatchId} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return summary;
    }

    private async escalateBatch(
        routeBatchId: number,
        batchStatus: string,
        shiftDate: string,
        escalationTime: string,
        reasonId: number | null,
        summary: FinalReviewEscalationSummary,
    ): Promise<void> {
        const dispatchIds = await this.repository.findDispatchIds(routeBatchId, 'scheduled', true);
        if (dispatchIds.length === 0) {
            summary.withoutPromisedOrdersBatchIds.push(routeBatchId);
            return;
        }

        let incidents = 0;
        let noticesSent = 0;
        let noticesFailed = 0;
        for (const dispatchId of dispatchIds) {
            const step = await this.repository.inBatchLock<Step>(routeBatchId, async (scope) => {
                if (!ESCALATABLE.includes(scope.status)) return { kind: 'batch_changed' };
                const state = await scope.dispatchState(dispatchId);
                if (!state || state.status !== 'scheduled' || !state.promiseNotifiedAt) return { kind: 'skip' };

                let incident = false;
                if (reasonId !== null && !state.escalated) {
                    const claimed = await scope.claimDispatchEvent(
                        dispatchId, FINAL_REVIEW_ESCALATED_EVENT,
                        'Second approval still pending at final_review_escalation_time (case 5.2)', { batchStatus, shiftDate },
                    );
                    if (claimed) {
                        await scope.registerIncident(dispatchId, reasonId);
                        incident = true;
                    }
                }

                let send: DispatchNoticeState | null = null;
                if (!state.riskNoticeSent && !state.maintainedSent) {
                    if (!state.contactEmail) {
                        await scope.recordContactManagementOnce(dispatchId, 'risk-notice', 'Risk notice: the order has no email; coordinator must contact the customer', {
                            category: 'customer_contact', deliveryResult: 'no_contact',
                        });
                    } else if (await scope.claimDispatchEvent(dispatchId, RISK_NOTICE_SENT_EVENT, 'Risk notice: email handed to the mail transport', { template: 'risk-notice' })) {
                        send = state;
                    }
                }
                return { kind: 'done', incident, send };
            });

            if (step?.kind === 'batch_changed') {
                // Approved (or otherwise moved) while we worked: stop, the late approval takes over.
                summary.approvedMeanwhileBatchIds.push(routeBatchId);
                summary.incidentsRegistered += incidents;
                summary.riskNoticesSent += noticesSent;
                summary.riskNoticesFailed += noticesFailed;
                return;
            }
            if (step?.kind !== 'done') continue;
            if (step.incident) incidents += 1;
            if (step.send) {
                const outcome = await this.notices.deliver(routeBatchId, step.send, 'send-risk-notice');
                if (outcome === 'sent') noticesSent += 1; else noticesFailed += 1;
            }
        }
        summary.incidentsRegistered += incidents;
        summary.riskNoticesSent += noticesSent;
        summary.riskNoticesFailed += noticesFailed;

        const detail = {
            routeBatchId,
            shiftDate,
            batchStatus,
            remnant: batchStatus === 'provisional',
            promisedOrders: dispatchIds.length,
            incidentsRegistered: incidents,
            riskNoticesSent: noticesSent,
            riskNoticesFailed: noticesFailed,
            finalReviewEscalationTime: escalationTime,
        };
        const closing = await this.repository.inBatchLock<Closing>(routeBatchId, async (scope) => {
            if (!ESCALATABLE.includes(scope.status)) return { kind: 'not_pending' };
            const wrote = await scope.recordBatchEventOnce(
                FINAL_REVIEW_ESCALATED_EVENT, 'Batch not approved at final_review_escalation_time; handled as case 5.2', detail,
            );
            if (!wrote) return { kind: 'already' };
            await scope.recordBatchEventOnce(
                COORDINATOR_TASK_REQUIRED_EVENT, 'Coordinator must approve or resolve this batch; no automatic approval exists', detail,
            );
            return { kind: 'escalated', event: await this.alerts.store('final_review_escalated', detail, scope.manager) };
        });
        if (closing?.kind === 'escalated') {
            this.alerts.announce(closing.event);
            summary.escalatedBatchIds.push(routeBatchId);
        } else if (closing?.kind === 'already') {
            summary.alreadyEscalatedBatchIds.push(routeBatchId);
        } else if (closing?.kind === 'not_pending') {
            summary.approvedMeanwhileBatchIds.push(routeBatchId);
        }
    }
}
