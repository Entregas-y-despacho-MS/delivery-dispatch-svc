import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { PlanningAlertsService } from '../../planning/services/planning-alerts.service.js';
import type { ScheduledTaskContext } from '../../scheduler/ports/scheduled-task.js';
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
}

const PENDING = MILESTONE_BATCH_STATUSES['review-end'];

/**
 * `final_review_end_time` (ST-51.4, D-46): a batch of the next route day that is still
 * `pending_final_review` raises one alert for every coordinator and the supervisor. It approves nothing
 * and tells no customer anything: the customers of these batches simply get no normal reminder.
 *
 * Idempotent by data: the `final_review_alerted` batch event is written first, in one statement that
 * also checks the batch is still pending, so a re-run or a second instance alerts nothing twice.
 */
@Injectable()
export class FinalReviewAlertService {
    constructor(
        private readonly settings: SettingsService,
        private readonly repository: FinalReviewRepository,
        private readonly alerts: PlanningAlertsService,
    ) {}

    async run(context: ScheduledTaskContext): Promise<FinalReviewAlertSummary> {
        const loaded = await loadFinalReviewSettings(this.settings);
        if (!loaded.ok) {
            await this.alerts.raise('settings_missing', { missingKeys: loaded.missingKeys, invalidKeys: loaded.invalidKeys });
            return { status: 'blocked', shiftDate: null, alertedBatchIds: [], alreadyAlertedBatchIds: [] };
        }
        const settings = loaded.values!;

        const shiftDate = shiftDateOfMilestone('review-end', context.startedAt, settings.calendar);
        const summary: FinalReviewAlertSummary = { status: 'executed', shiftDate, alertedBatchIds: [], alreadyAlertedBatchIds: [] };
        if (!shiftDate) return { ...summary, status: 'not_review_day' };

        for (const batch of await this.repository.findBatches(shiftDate, PENDING)) {
            const detail = {
                routeBatchId: batch.routeBatchId,
                shiftDate,
                reviewerUserId: batch.reviewerUserId,
                dispatchCount: batch.dispatchCount,
                finalReviewEndTime: settings.finalReviewEndTime,
                audience: [...FINAL_REVIEW_ALERT_AUDIENCE],
            };
            const wrote = await this.repository.recordBatchEventOnce(
                batch.routeBatchId,
                FINAL_REVIEW_ALERTED_EVENT,
                PENDING,
                'Batch still pending final review at final_review_end_time',
                detail,
            );
            if (!wrote) {
                summary.alreadyAlertedBatchIds.push(batch.routeBatchId);
                continue;
            }
            await this.alerts.raise('final_review_overdue', detail);
            summary.alertedBatchIds.push(batch.routeBatchId);
        }
        return summary;
    }
}
