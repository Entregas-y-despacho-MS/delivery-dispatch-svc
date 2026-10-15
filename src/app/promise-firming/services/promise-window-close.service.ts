import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { PromiseFirmingService, PROMISE_RESPONSE_WINDOW_KEY } from './promise-firming.service.js';
import { PromiseWindowCandidatesRepository } from './promise-window-candidates.repository.js';

const DEFAULT_WINDOW_MINUTES = 720;

export interface PromiseWindowCloseSummary {
    candidates: number;
    firmed: number;
    /** Someone else firmed it, or it is no longer eligible. */
    skipped: number;
    /** Eligible but the order of preparation cannot be built; NOT firmed. */
    incomplete: number;
    failed: number;
}

/**
 * Closes the customer's response window (ST-215.4, D-05): every dispatch with a valid notice whose
 * `promise_response_window_minutes` elapsed in silence becomes firm and the warehouse is asked to prepare it.
 *
 * Idempotent by data: `firm` only writes when `promise_firmed_at IS NULL`, so a repeated or concurrent
 * run, or a customer confirming at the same moment, can never emit a second order.
 */
@Injectable()
export class PromiseWindowCloseService {
    private readonly logger = new Logger(PromiseWindowCloseService.name);

    constructor(
        private readonly candidates: PromiseWindowCandidatesRepository,
        private readonly firming: PromiseFirmingService,
        private readonly settings: SettingsService,
    ) {}

    async run(now: Date = new Date()): Promise<PromiseWindowCloseSummary> {
        const windowMinutes = await this.settings.getNumber(PROMISE_RESPONSE_WINDOW_KEY, DEFAULT_WINDOW_MINUTES);
        const ids = await this.candidates.findClosable(now, windowMinutes);
        const summary: PromiseWindowCloseSummary = { candidates: ids.length, firmed: 0, skipped: 0, incomplete: 0, failed: 0 };

        for (const id of ids) {
            try {
                // One transaction per dispatch: a failure here never blocks or undoes the others.
                const result = await this.firming.firm(id, { reason: 'window_elapsed', now });
                if (result.outcome === 'firmed') summary.firmed += 1;
                else if (result.outcome === 'incomplete') summary.incomplete += 1;
                else summary.skipped += 1;
            } catch (error) {
                summary.failed += 1;
                this.logger.error(`Could not firm dispatch ${id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (ids.length > 0) this.logger.log(`Response window closed: ${JSON.stringify(summary)}`);
        // Throwing makes the runner record a failed run (nothing is marked as done); re-running is safe.
        if (summary.failed > 0) {
            throw new Error(`Promise window close: ${summary.failed} of ${summary.candidates} dispatches failed`);
        }
        return summary;
    }
}
