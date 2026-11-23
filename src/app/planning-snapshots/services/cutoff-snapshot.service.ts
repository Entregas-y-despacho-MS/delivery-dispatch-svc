import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OPERATING_TIMEZONE } from '../../planning/domain/operating-calendar.js';
import { buildCutoffUniverse, countUniverse, type UniverseCounts, type UniverseDispatchRead } from '../domain/cutoff-universe.js';

export interface CaptureCutoffInput {
    /** Operating day of the routes the cutoff plans (`YYYY-MM-DD`). */
    shiftDate: string;
    /** The instant of the cutoff: when the run started. */
    now: Date;
    /** `promise_response_window_minutes`, the same value the cutoff reoptimization uses. */
    windowMinutes: number;
    manual: boolean;
    /** `route-cutoff@YYYY-MM-DDTHH:mm`; `null` for a manual run. */
    occurrence: string | null;
}

export interface CaptureCutoffResult {
    planningCutoffId: number;
    /** `false`: the occurrence already had its snapshot, so nothing was written and the first one is kept. */
    created: boolean;
    counts: UniverseCounts | null;
}

/**
 * Freezes the planning universe of a D-1 cutoff (ST-302.2, ES-302): who was eligible at that moment and who was left
 * out, with the reason. It runs first, before the cutoff reorganizes anything, and in one transaction, so the
 * universe is what the cutoff found and not what it left behind.
 *
 * It reads every dispatch of the `provisional` batches of the day with its own query: the reading of the cutoff drops
 * batches without a warehouse or with a stop it cannot simulate, and using it would shrink the denominator without a
 * trace. The rule that decides who enters is the cutoff's own (`classifyStop`).
 *
 * One snapshot per scheduled occurrence: repeating the occurrence keeps the first one, so the denominator does not
 * change when a run is repeated and finds fewer provisional batches.
 */
@Injectable()
export class CutoffSnapshotService {
    private readonly logger = new Logger(CutoffSnapshotService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async capture(input: CaptureCutoffInput): Promise<CaptureCutoffResult> {
        // A scheduled run always has its occurrence; without one the database would refuse it (`chk_planning_cutoffs_occurrence`).
        const scheduled = !input.manual && input.occurrence !== null;
        const occurrence = scheduled ? input.occurrence : null;

        const result = await this.dataSource.transaction(async (manager) => {
            const created: { planning_cutoff_id: number }[] = await manager.query(
                `INSERT INTO planning_cutoffs (shift_date, cutoff_at, operating_timezone, trigger_type, occurrence)
                 VALUES ($1::date, $2, $3, $4, $5)
                 ON CONFLICT (occurrence) WHERE occurrence IS NOT NULL DO NOTHING
                 RETURNING planning_cutoff_id`,
                [input.shiftDate, input.now, OPERATING_TIMEZONE, scheduled ? 'scheduled' : 'manual', occurrence],
            );
            if (created.length === 0) {
                const [existing]: { planning_cutoff_id: number }[] = await manager.query(
                    `SELECT planning_cutoff_id FROM planning_cutoffs WHERE occurrence = $1`,
                    [occurrence],
                );
                return { planningCutoffId: existing.planning_cutoff_id, created: false, counts: null };
            }

            const planningCutoffId = created[0].planning_cutoff_id;
            const entries = buildCutoffUniverse(await this.readUniverse(manager, input.shiftDate), input.now, input.windowMinutes);
            if (entries.length > 0) {
                await manager.query(
                    `INSERT INTO planning_cutoff_dispatches
                        (planning_cutoff_id, dispatch_id, universe_status, exclusion_code, exclusion_detail, route_batch_id,
                         route_version, dispatch_type_id, delivery_zone_id, origin_warehouse_id, scheduled_window_start)
                     SELECT $1, x."dispatchId", x."universeStatus", x."exclusionCode", x."exclusionDetail", x."routeBatchId",
                            x."routeVersion", x."dispatchTypeId", x."deliveryZoneId", x."originWarehouseId", x."scheduledWindowStart"
                       FROM jsonb_to_recordset($2::jsonb) AS x(
                            "dispatchId" int, "universeStatus" text, "exclusionCode" text, "exclusionDetail" text,
                            "routeBatchId" int, "routeVersion" int, "dispatchTypeId" int, "deliveryZoneId" int,
                            "originWarehouseId" int, "scheduledWindowStart" timestamptz)`,
                    [planningCutoffId, JSON.stringify(entries)],
                );
            }
            return { planningCutoffId, created: true, counts: countUniverse(entries) };
        });

        if (result.counts) {
            this.logger.log(
                `Planning snapshot ${result.planningCutoffId} for ${input.shiftDate}: ` +
                `${result.counts.eligible} eligible, ${result.counts.excluded} excluded.`,
            );
        } else {
            this.logger.log(`Planning snapshot ${result.planningCutoffId} already existed for ${occurrence}; the first one is kept.`);
        }
        return result;
    }

    /** Every dispatch of the provisional batches of the day, with no filter on warehouse, sequence or coordinates. */
    private async readUniverse(manager: EntityManager, shiftDate: string): Promise<UniverseDispatchRead[]> {
        return await manager.query(
            `SELECT d.dispatch_id AS "dispatchId", b.route_batch_id AS "routeBatchId", b.version AS "routeVersion",
                    d.dispatch_type_id AS "dispatchTypeId", t.name AS "dispatchType", s.name AS "status",
                    b.delivery_zone_id AS "deliveryZoneId", b.origin_warehouse_id AS "originWarehouseId",
                    d.scheduled_window_start AS "scheduledWindowStart",
                    d.promise_notified_at AS "promiseNotifiedAt", d.promise_firmed_at AS "promiseFirmedAt"
               FROM route_batches b
               JOIN dispatches d ON d.route_batch_id = b.route_batch_id
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
              WHERE b.status = 'provisional' AND b.shift_date = $1::date
              ORDER BY d.dispatch_id`,
            [shiftDate],
        );
    }
}
