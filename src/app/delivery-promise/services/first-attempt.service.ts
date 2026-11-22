import { Injectable } from '@nestjs/common';
import {
    buildFirstAttempt, classifyFirstAttempt, normalizeAttempts, summarizeAttempts, tallyFirstAttempts,
    type DispatchAttemptSummary,
} from '../domain/first-attempt.js';
import type { FirstAttemptDto } from '../dto/otd-report.dto.js';
import { AttemptsRepository, type DispatchAttemptSource } from '../repositories/attempts.repository.js';
import type { DeliveryPromiseFilters } from '../repositories/delivery-promise.sql.js';

const windowOf = (source: DispatchAttemptSource) => ({ start: source.windowStart, end: source.windowEnd });

/**
 * ST-301.3 — delivery at the first attempt. Reads the status events of the dispatches in the range, rebuilds their attempts
 * with the pure rule of `domain/first-attempt.ts` and counts how each first attempt went. The rate covers only the
 * instrumented period: a range that starts earlier is N/D, and a dispatch whose history cannot be rebuilt is counted apart.
 */
@Injectable()
export class FirstAttemptService {
    constructor(private readonly repository: AttemptsRepository) {}

    async getFirstAttempt(filters: DeliveryPromiseFilters): Promise<FirstAttemptDto> {
        const [sources, coverage] = await Promise.all([this.repository.listSources(filters), this.repository.findCoverage(filters.from)]);
        const results = sources.map((source) => classifyFirstAttempt(normalizeAttempts(source.events), windowOf(source), source.status));
        return buildFirstAttempt(tallyFirstAttempts(results), coverage);
    }

    /** Attempts used and first result of each given dispatch (the open overdue list). */
    async summarize(dispatchIds: number[]): Promise<Map<number, DispatchAttemptSummary>> {
        const sources = await this.repository.listSourcesByIds(dispatchIds);
        return new Map(sources.map((source) => [source.dispatchId, summarizeAttempts(source.events, windowOf(source), source.status)]));
    }
}
