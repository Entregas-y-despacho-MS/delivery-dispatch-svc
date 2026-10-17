import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { PlanningAlertsService } from '../../planning/services/planning-alerts.service.js';
import type { ScheduledTaskContext } from '../../scheduler/ports/scheduled-task.js';
import {
    loadFinalReviewSettings,
    MILESTONE_BATCH_STATUSES,
    shiftDateOfMilestone,
} from '../domain/final-review-timeline.js';
import { nearestMinute } from '../../scheduler/domain/task-schedule.js';
import { CustomerNoticeService, emptyNoticeSummary, type CustomerNoticeSummary } from './customer-notice.service.js';
import { FinalReviewRepository } from './final-review.repository.js';

export interface RouteReminderSummary {
    status: 'executed' | 'blocked' | 'not_reminder_day';
    shiftDate: string | null;
    batchIds: number[];
    totals: CustomerNoticeSummary;
}

const emptyTotals = emptyNoticeSummary;

/**
 * `route_reminder_time` (ST-51.4, D-46): the reminder (date, window and tracking link) for the customers
 * of the next route day, **only for `confirmed` batches**. A batch still in `pending_final_review` (or a
 * remnant of the cutoff) is not read at all, so its customers get no normal reminder; if it is approved
 * later, `LateApprovalNoticeListener` sends it at that moment.
 */
@Injectable()
export class RouteReminderService {
    constructor(
        private readonly settings: SettingsService,
        private readonly repository: FinalReviewRepository,
        private readonly notices: CustomerNoticeService,
        private readonly alerts: PlanningAlertsService,
    ) {}

    async run(context: ScheduledTaskContext): Promise<RouteReminderSummary> {
        const loaded = await loadFinalReviewSettings(this.settings);
        if (!loaded.ok) {
            await this.alerts.raise('settings_missing', { missingKeys: loaded.missingKeys, invalidKeys: loaded.invalidKeys });
            return { status: 'blocked', shiftDate: null, batchIds: [], totals: emptyTotals() };
        }
        const settings = loaded.values!;

        // The ticker fires on the nearest minute, but the runner stamps the real clock: at 16:29:59.9 the
        // reminder would read "not yet" and nobody would send it. Evaluate at the minute the ticker saw.
        const now = nearestMinute(context.startedAt);
        const shiftDate = shiftDateOfMilestone('reminder', now, settings.calendar);
        if (!shiftDate) return { status: 'not_reminder_day', shiftDate: null, batchIds: [], totals: emptyTotals() };

        const summary: RouteReminderSummary = { status: 'executed', shiftDate, batchIds: [], totals: emptyTotals() };
        for (const batch of await this.repository.findBatches(shiftDate, MILESTONE_BATCH_STATUSES.reminder)) {
            const sent = await this.notices.sendDueNotices(batch.routeBatchId, shiftDate, now, settings);
            summary.batchIds.push(batch.routeBatchId);
            for (const key of Object.keys(summary.totals) as Array<keyof CustomerNoticeSummary>) summary.totals[key] += sent[key];
        }
        return summary;
    }
}
