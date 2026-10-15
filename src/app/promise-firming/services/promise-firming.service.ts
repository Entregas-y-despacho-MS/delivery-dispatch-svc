import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { OutboxService } from '../../../modules/messaging/outbound-messages/services/outbox.service.js';
import { buildEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { DispatchStatusEnum } from '../../../shared/enums/index.js';
import {
    PREPARE_REQUESTED_TOPIC,
    PromiseFirmingReason,
    PromiseFirmingResult,
} from '../domain/promise-firming.types.js';

export const PROMISE_RESPONSE_WINDOW_KEY = 'promise_response_window_minutes';
const DEFAULT_WINDOW_MINUTES = 720;

/** States in which a promise can still be firmed (the 2nd approval does not undo a communicated promise). */
const FIRMABLE_STATUSES: string[] = [DispatchStatusEnum.SCHEDULED, DispatchStatusEnum.ASSIGNED];

interface FirmingRow {
    id: number;
    status: string;
    version: number;
    source_order_ref: string;
    tracking_code: string | null;
    promise_notified_at: Date | null;
    promise_firmed_at: Date | null;
    customer_confirmation: string;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    departure_date: string | null;
    warehouse_code: string | null;
}

interface PackageRow {
    external_package_id: string;
    length_cm: string | number;
    width_cm: string | number;
    height_cm: string | number;
    gross_weight_kg: string | number;
}

export interface FirmPromiseOptions {
    reason: PromiseFirmingReason;
    /** The instant used as `promise_firmed_at`, the window check and `updatedAt`. Injectable for tests. */
    now?: Date;
    /** Run inside an existing transaction; otherwise one is opened. */
    manager?: EntityManager;
}

/**
 * Firms the promise of one dispatch and asks the warehouse to prepare it (ST-215.4, D-05, D-47).
 *
 * Firm = `promise_firmed_at` set + `customer_confirmation = 'confirmed'` + `promise_firmed` event +
 * `dispatch.shipment.prepare_requested` in the outbox, all in ONE transaction, so the order exists if and
 * only if the promise was firmed. The `UPDATE ... WHERE promise_firmed_at IS NULL` is the single-emission
 * guard: two instances, or the timer racing the customer, can never queue it twice.
 *
 * The task of the 12 h window uses it with `window_elapsed`; the public confirmation endpoint (ST-N3.1)
 * uses it with `customer_confirmed`. It does NOT touch `dispatches.version`: confirming or staying silent
 * does not move the plan (DICTIONARY, `version`); `recordVersion` is that version as it stands.
 */
@Injectable()
export class PromiseFirmingService {
    private readonly logger = new Logger(PromiseFirmingService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly outbox: OutboxService,
        private readonly settings: SettingsService,
    ) {}

    async firm(dispatchId: number, options: FirmPromiseOptions): Promise<PromiseFirmingResult> {
        const now = options.now ?? new Date();
        const windowMinutes = await this.settings.getNumber(PROMISE_RESPONSE_WINDOW_KEY, DEFAULT_WINDOW_MINUTES);
        if (options.manager) return await this.firmIn(options.manager, dispatchId, options.reason, now, windowMinutes);
        return await this.dataSource.transaction(
            async (manager) => await this.firmIn(manager, dispatchId, options.reason, now, windowMinutes),
        );
    }

    private async firmIn(
        manager: EntityManager,
        dispatchId: number,
        reason: PromiseFirmingReason,
        now: Date,
        windowMinutes: number,
    ): Promise<PromiseFirmingResult> {
        const [row]: FirmingRow[] = await manager.query(
            `SELECT d.dispatch_id AS id, ds.name AS status, d.version, d.source_order_ref, d.tracking_code,
                    d.promise_notified_at, d.promise_firmed_at, d.customer_confirmation,
                    d.scheduled_window_start, d.scheduled_window_end,
                    to_char(rb.shift_date, 'YYYY-MM-DD') AS departure_date, w.code AS warehouse_code
               FROM dispatches d
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
               LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
               LEFT JOIN warehouses w ON w.warehouse_id = d.origin_warehouse_id
              WHERE d.dispatch_id = $1
                FOR UPDATE OF d`,
            [dispatchId],
        );
        if (!row) return { outcome: 'not_eligible', dispatchId, cause: 'not_found' };
        if (row.promise_firmed_at) return { outcome: 'already_firmed', dispatchId };

        const cause = this.notEligibleCause(row, reason, now, windowMinutes);
        if (cause) return { outcome: 'not_eligible', dispatchId, cause };

        // The order of preparation needs a record version >= 1 and complete data (contract). Without
        // them the promise is NOT firmed: firmness is what triggers the order, so firming without it
        // would leave the warehouse unaware of a promise that is already binding.
        if (row.version < 1) {
            this.logger.warn(`Dispatch ${dispatchId} has version ${row.version}; the preparation order was not emitted.`);
            return { outcome: 'incomplete', dispatchId, cause: 'invalid_version' };
        }
        const packages: PackageRow[] = await manager.query(
            `SELECT external_package_id, length_cm, width_cm, height_cm, gross_weight_kg
               FROM dispatch_packages WHERE dispatch_id = $1 ORDER BY dispatch_package_id`,
            [dispatchId],
        );
        const missing = this.missingData(row, packages);
        if (missing) {
            this.logger.warn(`Dispatch ${dispatchId} cannot be firmed: ${missing}.`);
            return { outcome: 'incomplete', dispatchId, cause: missing };
        }

        const updated: { dispatch_id: number }[] = await manager.query(
            `UPDATE dispatches
                SET promise_firmed_at = $2, customer_confirmation = 'confirmed', updated_at = NOW()
              WHERE dispatch_id = $1 AND promise_firmed_at IS NULL
            RETURNING dispatch_id`,
            [dispatchId, now],
        );
        if (updated.length === 0) return { outcome: 'already_firmed', dispatchId };

        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             VALUES ($1, 'promise_firmed', $2, $3, $4::jsonb)`,
            [
                dispatchId,
                reason === 'customer_confirmed' ? 'customer' : 'system',
                reason === 'customer_confirmed'
                    ? 'Customer confirmed the promise'
                    : 'Response window elapsed with a valid notice',
                JSON.stringify({ reason, recordVersion: row.version, windowMinutes }),
            ],
        );

        await this.outbox.enqueue(
            buildEnvelope({
                type: PREPARE_REQUESTED_TOPIC,
                source: 'dispatch',
                occurredAt: now,
                data: {
                    salesOrderId: row.source_order_ref,
                    trackingCode: row.tracking_code,
                    recordVersion: row.version,
                    updatedAt: now.toISOString(),
                    warehouseId: row.warehouse_code,
                    departureDate: row.departure_date,
                    deliveryWindowStart: row.scheduled_window_start?.toISOString(),
                    deliveryWindowEnd: row.scheduled_window_end?.toISOString(),
                    packages: packages.map((p) => ({
                        packageId: p.external_package_id,
                        lengthCm: Number(p.length_cm),
                        widthCm: Number(p.width_cm),
                        heightCm: Number(p.height_cm),
                        grossWeightKg: Number(p.gross_weight_kg),
                    })),
                },
            }),
            { manager },
        );
        return { outcome: 'firmed', dispatchId, recordVersion: row.version, reason };
    }

    private notEligibleCause(row: FirmingRow, reason: PromiseFirmingReason, now: Date, windowMinutes: number): string | null {
        if (!FIRMABLE_STATUSES.includes(row.status)) return 'status';
        // Without a valid notice there is no promise to firm; a bounce never sets `promise_notified_at`.
        if (!row.promise_notified_at) return 'no_valid_notice';
        if (row.customer_confirmation !== 'pending') return 'customer_response_recorded';
        if (reason === 'window_elapsed') {
            const closesAt = row.promise_notified_at.getTime() + windowMinutes * 60_000;
            if (now.getTime() < closesAt) return 'window_open';
        }
        return null;
    }

    private missingData(row: FirmingRow, packages: PackageRow[]): string | null {
        if (!row.source_order_ref) return 'missing_sales_order';
        if (!row.tracking_code) return 'missing_tracking_code';
        if (!row.departure_date) return 'missing_departure_date';
        if (packages.length === 0) return 'missing_packages';
        return null;
    }
}
