import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { OsrmTableTooBigException, OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import type { ScheduledTaskContext } from '../../scheduler/ports/scheduled-task.js';
import { PlanningSettingsMissingException } from '../exceptions/index.js';
import { localDate } from '../domain/operating-calendar.js';
import { loadPlanningSettings } from '../domain/planning-settings.js';
import type { PlanProposal, UnplannedDispatch } from '../domain/plan-types.js';
import type { PlanAlertDto, PlanGenerationSummaryDto } from '../dto/plan-generation-summary.dto.js';
import { LotPlanner } from '../ports/lot-planner.js';
import { PlanCandidatesRepository } from './plan-candidates.repository.js';
import { PlanningAlertsService, type PlanAlertKind } from './planning-alerts.service.js';
import { PlanWriterService, type WriteContext } from './plan-writer.service.js';

/** `reason` of the dispatch event that remembers an exception was already reported. */
const DEADLINE_REASON = 'promise_deadline_exceeded';

/**
 * One run of the batch generator (plan §2): read, plan (every OSRM matrix is asked for before
 * anything is written), then write one transaction per batch. It is idempotent by data: it only
 * takes orders without a batch, so running it twice is the same as running it once.
 */
@Injectable()
export class PlanGenerationService {
    private readonly logger = new Logger(PlanGenerationService.name);

    constructor(
        private readonly settings: SettingsService,
        private readonly candidates: PlanCandidatesRepository,
        private readonly planner: LotPlanner,
        private readonly writer: PlanWriterService,
        private readonly alerts: PlanningAlertsService,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    async run(context: ScheduledTaskContext): Promise<PlanGenerationSummaryDto> {
        const manual = context.trigger === 'manual';
        const writeContext: WriteContext = {
            trigger: manual ? 'manual' : 'scheduled',
            occurrence: context.occurrence,
        };

        // A scheduled run that is blocked ends without error (retrying every minute would not help);
        // a manual one answers 422 so the person sees why.
        const loaded = await loadPlanningSettings(this.settings);
        if (!loaded.ok) {
            await this.alerts.raise('settings_missing', {
                missingKeys: loaded.missingKeys,
                invalidKeys: loaded.invalidKeys,
                configurationProblem: loaded.configurationProblem,
            });
            if (manual) {
                throw new PlanningSettingsMissingException(loaded.missingKeys, loaded.invalidKeys, loaded.configurationProblem);
            }
            return emptySummary('blocked', loaded.missingKeys);
        }
        const settings = loaded.values!;

        const now = new Date();
        const today = localDate(now);
        const [dispatches, vehicles, driverIds, warehouses, existingBatches, openBatches] = await Promise.all([
            this.candidates.findCandidates(),
            this.candidates.findVehicles(),
            this.candidates.findDriverIds(),
            this.candidates.findWarehouses(),
            this.candidates.findExistingBatches(today),
            this.candidates.findOpenBatches(today),
        ]);

        let proposal: PlanProposal;
        try {
            proposal = await this.planner.plan({ now, settings, dispatches, vehicles, driverIds, warehouses, existingBatches, openBatches });
        } catch (error) {
            if (error instanceof OsrmUnavailableException) {
                await this.alerts.raise('osrm_unavailable', { message: error.message });
            } else if (error instanceof OsrmTableTooBigException) {
                await this.alerts.raise('osrm_table_limit_exceeded', { message: error.message });
            }
            throw error;
        }

        const summary = emptySummary('executed', []);

        for (const insertion of proposal.insertions) {
            try {
                const written = await this.writer.writeInsertion(insertion, writeContext);
                if (written.applied) {
                    summary.updatedBatchIds.push(written.routeBatchId);
                    summary.plannedDispatchIds.push(...written.insertedDispatchIds);
                }
            } catch (error) {
                this.logger.error(`Late orders of batch ${insertion.routeBatchId} could not be inserted: ${describe(error)}`);
            }
        }
        for (const batch of proposal.batches) {
            try {
                const written = await this.writer.writeNewBatch(batch, writeContext);
                if (written.routeBatchId !== null) {
                    summary.createdBatchIds.push(written.routeBatchId);
                    summary.plannedDispatchIds.push(...written.plannedDispatchIds);
                }
            } catch (error) {
                // One batch failing (a vehicle taken by someone else...) must not lose the others;
                // its orders are still pending and the next run plans them.
                this.logger.error(`A batch for ${batch.shiftDate} could not be written: ${describe(error)}`);
            }
        }

        for (const unplanned of proposal.unplanned) {
            summary.exceptions.push({ kind: unplanned.reason, detail: { dispatchId: unplanned.dispatchId, ...unplanned.detail } });
            await this.reportException(unplanned);
        }

        const warnings: PlanAlertDto[] = proposal.warnings.map((warning) => ({ kind: warning.kind, detail: warning.detail }));
        for (const warning of loaded.warnings) warnings.push({ kind: warning, detail: {} });
        for (const warning of warnings) {
            summary.warnings.push(warning);
            await this.alerts.raise(warning.kind as PlanAlertKind, warning.detail);
        }

        this.logger.log(
            `Plan generation (${writeContext.trigger}): ${summary.createdBatchIds.length} batches created, ` +
            `${summary.updatedBatchIds.length} updated, ${summary.plannedDispatchIds.length} orders planned, ` +
            `${summary.exceptions.length} exceptions, ${summary.warnings.length} warnings.`,
        );
        return summary;
    }

    /**
     * An order that cannot be planned is reported once: a `plan_exception` dispatch event with its reason
     * remembers it, so the next run does not raise the same alert again.
     */
    private async reportException(unplanned: UnplannedDispatch): Promise<void> {
        const reason = unplanned.reason === 'deadline_exceeded' ? DEADLINE_REASON : unplanned.reason;
        try {
            const known: unknown[] = await this.dataSource.query(
                `SELECT 1 FROM dispatch_events
                  WHERE dispatch_id = $1 AND event_type = 'plan_exception' AND reason = $2 LIMIT 1`,
                [unplanned.dispatchId, reason],
            );
            if (known.length > 0) return;

            await this.dataSource.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, detail, actor_type, reason, metadata)
                 VALUES ($1, 'plan_exception', $2, 'system', $3, $4)`,
                [unplanned.dispatchId, 'The order could not be planned.', reason, JSON.stringify(unplanned.detail)],
            );
        } catch (error) {
            this.logger.error(`Exception of order ${unplanned.dispatchId} could not be recorded: ${describe(error)}`);
            return;
        }
        await this.alerts.raise(unplanned.reason, { dispatchId: unplanned.dispatchId, ...unplanned.detail });
    }
}

function emptySummary(status: 'executed' | 'blocked', missingKeys: string[]): PlanGenerationSummaryDto {
    return {
        status,
        createdBatchIds: [],
        updatedBatchIds: [],
        plannedDispatchIds: [],
        exceptions: [],
        warnings: [],
        missingKeys,
    };
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
