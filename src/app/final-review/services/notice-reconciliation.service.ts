import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { addDays, localDate, nextOperatingDay } from '../../planning/domain/operating-calendar.js';
import { nearestMinute } from '../../scheduler/domain/task-schedule.js';
import type { ScheduledTaskContext } from '../../scheduler/ports/scheduled-task.js';
import { loadFinalReviewSettings, reminderInstant } from '../domain/final-review-timeline.js';
import { CustomerNoticeService, emptyNoticeSummary, type CustomerNoticeSummary } from './customer-notice.service.js';
import { FinalReviewRepository } from './final-review.repository.js';

export interface NoticeReconciliationSummary {
    status: 'executed' | 'blocked';
    from: string | null;
    to: string | null;
    /** Reservations closed as `abandoned` (a coordinator follow-up was opened for each). */
    abandoned: number;
    /** Reservations that could not be closed (database error); the next run tries again. */
    abandonedErrors: number;
    batchIds: number[];
    notices: CustomerNoticeSummary;
}

/** Batches whose customers can still be owed a notice, or whose emails can be stuck. */
const LIVE_STATUSES = ['confirmed', 'pending_final_review', 'provisional'] as const;

/**
 * Safety net of the customer emails (ST-51.4). It runs every few minutes, over the batches of yesterday, today and
 * the next route day, and does two things, both idempotent:
 *
 * 1. **Abandoned reservations.** An email reserved but never given a result (the process died before or while
 *    calling the mailer, or the transport hung past the lease) is closed as `abandoned` and the coordinator gets
 *    a `contact_management_required` follow-up. It is NOT resent: it may have left before the crash. Past the
 *    lease the reservation already counts as failed in the decision, so a late approval is not stuck behind it.
 * 2. **Notices still owed.** For `confirmed` batches whose reminder hour has passed, it decides again the orders that
 *    have no reminder or «se mantiene» reserved: those deferred because the risk notice was in flight when the
 *    process died, and also the reminder of a tick that was lost (the service was down at 16:30).
 */
@Injectable()
export class NoticeReconciliationService {
    private readonly logger = new Logger(NoticeReconciliationService.name);

    constructor(
        private readonly settings: SettingsService,
        private readonly repository: FinalReviewRepository,
        private readonly notices: CustomerNoticeService,
    ) {}

    async run(context: ScheduledTaskContext): Promise<NoticeReconciliationSummary> {
        const summary: NoticeReconciliationSummary = {
            status: 'executed', from: null, to: null, abandoned: 0, abandonedErrors: 0, batchIds: [], notices: emptyNoticeSummary(),
        };
        const loaded = await loadFinalReviewSettings(this.settings);
        if (!loaded.ok) {
            // No alert here: this runs every few minutes and would repeat it; the three timeline tasks already raise it.
            this.logger.warn(`Notice reconciliation skipped: missing ${loaded.missingKeys.join(', ') || '-'}, invalid ${loaded.invalidKeys.join(', ') || '-'}.`);
            return { ...summary, status: 'blocked' };
        }
        const settings = loaded.values!;

        const now = nearestMinute(context.startedAt);
        const today = localDate(now);
        const from = addDays(today, -1);
        const to = nextOperatingDay(today, settings.calendar);
        summary.from = from;
        summary.to = to;

        for (const batch of await this.repository.findBatchesInRange(from, to, LIVE_STATUSES)) {
            summary.batchIds.push(batch.routeBatchId);

            for (const notice of await this.repository.findAbandonedNotices(batch.routeBatchId)) {
                try {
                    const closed = await this.repository.inBatchLock(batch.routeBatchId, (scope) => scope.abandonNotice(notice.dispatchId, notice.template));
                    if (closed) summary.abandoned += 1;
                } catch (error) {
                    summary.abandonedErrors += 1;
                    this.logger.error(`Could not close the abandoned "${notice.template}" of dispatch ${notice.dispatchId}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            // Notices are only owed for a route day that has not passed and whose reminder hour has come.
            if (batch.status !== 'confirmed' || batch.shiftDate < today) continue;
            if (now.getTime() < reminderInstant(batch.shiftDate, settings).getTime()) continue;
            const sent = await this.notices.sendDueNotices(batch.routeBatchId, batch.shiftDate, now, settings, { onlyPending: true });
            for (const key of Object.keys(summary.notices) as Array<keyof CustomerNoticeSummary>) summary.notices[key] += sent[key];
        }
        return summary;
    }
}
