import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { buildManifestStops, type ManifestSourceStop, type ManifestStopRow } from '../domain/manifest-stops.js';
import type { RouteManifestKind } from '../entities/route-manifest.entity.js';

export interface RecordManifestInput {
    routeBatchId: number;
    kind: RouteManifestKind;
    /** `null` when the system did it. */
    actorUserId: number | null;
    /** Mandatory for `revised`: the database refuses a revision without a reason. */
    reason?: string | null;
    /**
     * Stops held back by a failed package check. When it is not given, a `started`/`revised` manifest reads them from the
     * cotejo events of the batch (the same rule `RouteBatchStartService` applies); a `confirmed` one has none.
     */
    excludedDispatchIds?: readonly number[];
}

export interface RecordedManifest {
    routeManifestId: number;
    manifestVersion: number;
    routeVersion: number;
    stops: ManifestStopRow[];
}

/**
 * Freezes a route as a manifest (ST-302.2, ES-302): who was on it, in which order and in which state, with the
 * version of the route and its vehicle and driver at that moment. A change after the first manifest adds the next
 * `manifest_version`; nothing already written is touched (the database rejects it).
 *
 * It always runs inside the transaction of the caller, which already holds the lock of the batch: the manifest is
 * written together with the change it describes, or not at all. A route confirmed or started without its manifest
 * would be a fact nobody can recover.
 */
@Injectable()
export class RouteManifestService {
    async record(manager: EntityManager, input: RecordManifestInput): Promise<RecordedManifest> {
        const [batch]: { version: number; vehicle_id: number | null; driver_id: number | null }[] = await manager.query(
            // The caller already holds this lock; taking it here makes `manifest_version = max + 1` safe even for a caller that forgot.
            `SELECT version, vehicle_id, driver_id FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
            [input.routeBatchId],
        );
        if (!batch) throw new Error(`Route batch ${input.routeBatchId} does not exist; its manifest cannot be written.`);
        if (input.kind === 'revised' && !input.reason?.trim()) {
            throw new Error('A revised manifest needs a reason.');
        }

        const sourceStops: { dispatch_id: number; dispatch_type_id: number; sequence_order: number | null }[] = await manager.query(
            `SELECT dispatch_id, dispatch_type_id, sequence_order FROM dispatches WHERE route_batch_id = $1`,
            [input.routeBatchId],
        );
        const stops: ManifestSourceStop[] = sourceStops.map((row) => ({
            dispatchId: row.dispatch_id,
            dispatchTypeId: row.dispatch_type_id,
            sequenceOrder: row.sequence_order,
        }));
        const excluded =
            input.kind === 'confirmed'
                ? []
                : input.excludedDispatchIds ?? (await this.findCotejoExcluded(manager, input.routeBatchId, stops));
        const rows = buildManifestStops(input.kind, stops, excluded);

        const [{ next }]: { next: number }[] = await manager.query(
            `SELECT COALESCE(MAX(manifest_version), 0) + 1 AS next FROM route_manifests WHERE route_batch_id = $1`,
            [input.routeBatchId],
        );
        const [created]: { route_manifest_id: number }[] = await manager.query(
            `INSERT INTO route_manifests (route_batch_id, manifest_version, kind, route_version, vehicle_id, driver_id, actor_user_id, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING route_manifest_id`,
            [input.routeBatchId, next, input.kind, batch.version, batch.vehicle_id, batch.driver_id, input.actorUserId, input.reason?.trim() || null],
        );
        if (rows.length > 0) {
            await manager.query(
                `INSERT INTO route_manifest_stops (route_manifest_id, dispatch_id, dispatch_type_id, sequence_order, stop_state, exclusion_code)
                 SELECT $1, x."dispatchId", x."dispatchTypeId", x."sequenceOrder", x."stopState", x."exclusionCode"
                   FROM jsonb_to_recordset($2::jsonb) AS x(
                        "dispatchId" int, "dispatchTypeId" int, "sequenceOrder" int, "stopState" text, "exclusionCode" text)`,
                [created.route_manifest_id, JSON.stringify(rows)],
            );
        }
        return { routeManifestId: created.route_manifest_id, manifestVersion: next, routeVersion: batch.version, stops: rows };
    }

    /** Stops of the batch whose latest cotejo event for this batch is a failure (the rule of the route start). */
    private async findCotejoExcluded(manager: EntityManager, routeBatchId: number, stops: readonly ManifestSourceStop[]): Promise<number[]> {
        if (stops.length === 0) return [];
        const rows: { dispatch_id: number; event_type: string }[] = await manager.query(
            `SELECT DISTINCT ON (e.dispatch_id) e.dispatch_id, e.event_type
               FROM dispatch_events e
              WHERE e.dispatch_id = ANY($1::int[])
                AND e.event_type IN ('cotejo_failed', 'cotejo_resolved')
                AND e.metadata->>'routeBatchId' = $2::text
              ORDER BY e.dispatch_id, e.created_at DESC, e.dispatch_event_id DESC`,
            [stops.map((stop) => stop.dispatchId), routeBatchId],
        );
        return rows.filter((row) => row.event_type === 'cotejo_failed').map((row) => row.dispatch_id);
    }
}
