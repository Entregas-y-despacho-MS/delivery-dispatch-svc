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
import { FINAL_REVIEW_ALERT_AUDIENCE, FINAL_REVIEW_ALERTED_EVENT } from '../final-review-events.js';
import { FinalReviewRepository } from './final-review.repository.js';

export interface FinalReviewAlertSummary {
    status: 'executed' | 'blocked' | 'not_review_day';
    shiftDate: string | null;
    alertedBatchIds: number[];
    /** Batches that already had their alert in an earlier run. */
    alreadyAlertedBatchIds: number[];
    /** Batches whose alert could not be stored; the next run tries again. */
    failedBatchIds: number[];
}

const PENDING = MILESTONE_BATCH_STATUSES['review-end'];

type Outcome = { kind: 'not_pending' | 'already' } | { kind: 'alerted'; event: PlanningAlertEvent };

/**
 * `final_review_end_time` (ST-51.4, D-46): a batch of the next route day that is still
 * `pending_final_review` raises one alert for every coordinator and the supervisor. It approves nothing
 * and tells no customer anything: the customers of these batches simply get no normal reminder.
 *
 * Idempotent and crash-safe: under the lock of the batch, the `final_review_alerted` marker and the alert
 * row in `audit_logs` are written in ONE transaction, so a failure leaves neither (the next run alerts) and
 * a re-run or a second instance alerts nothing twice. The event is announced after the commit.
 */
@Injectable()
export class FinalReviewAlertService {
    private readonly logger = new Logger(FinalReviewAlertService.name);

    constructor(
        private readonly settings: SettingsService,
        private readonly repository: FinalReviewRepository,
        private readonly alerts: PlanningAlertsService,
    ) {}

    async run(context: ScheduledTaskContext): Promise<FinalReviewAlertSummary> {
        const summary: FinalReviewAlertSummary = {
            status: 'executed', shiftDate: null, alertedBatchIds: [], alreadyAlertedBatchIds: [], failedBatchIds: [],
        };
        const loaded = await loadFinalReviewSettings(this.settings);
        if (!loaded.ok) {
            await this.alerts.raise('settings_missing', { missingKeys: loaded.missingKeys, invalidKeys: loaded.invalidKeys });
            return { ...summary, status: 'blocked' };
        }
        const settings = loaded.values!;

        // The ticker decides with the nearest minute; use the same instant so 16:29:59.9 is 16:30.
        const shiftDate = shiftDateOfMilestone('review-end', nearestMinute(context.startedAt), settings.calendar);
        if (!shiftDate) return { ...summary, status: 'not_review_day' };
        summary.shiftDate = shiftDate;

        for (const batch of await this.repository.findBatches(shiftDate, PENDING)) {
            const detail = {
                routeBatchId: batch.routeBatchId,
                shiftDate,
                reviewerUserId: batch.reviewerUserId,
                dispatchCount: batch.dispatchCount,
                finalReviewEndTime: settings.finalReviewEndTime,
                audience: [...FINAL_REVIEW_ALERT_AUDIENCE],
            };
            try {
                const outcome = await this.repository.inBatchLock<Outcome>(batch.routeBatchId, async (scope) => {
                    if (!PENDING.includes(scope.status)) return { kind: 'not_pending' };
                    const wrote = await scope.recordBatchEventOnce(
                        FINAL_REVIEW_ALERTED_EVENT, 'Batch still pending final review at final_review_end_time', detail,
                    );
                    if (!wrote) return { kind: 'already' };
                    return { kind: 'alerted', event: await this.alerts.store('final_review_overdue', detail, scope.manager) };
                });
                if (outcome?.kind === 'alerted') {
                    this.alerts.announce(outcome.event);
                    summary.alertedBatchIds.push(batch.routeBatchId);
                } else if (outcome?.kind === 'already') {
                    summary.alreadyAlertedBatchIds.push(batch.routeBatchId);
                }
            } catch (error) {
                summary.failedBatchIds.push(batch.routeBatchId);
                this.logger.error(`Alert for batch ${batch.routeBatchId} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return summary;
    }
}
