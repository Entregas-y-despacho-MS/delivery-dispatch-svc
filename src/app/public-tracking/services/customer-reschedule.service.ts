import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { RouteBatchStatusEnum } from '../../../shared/enums/index.js';
import { RouteCapacityExceededException } from '../../../modules/dispatch/route-batches/exceptions/index.js';
import { RouteCapacityService } from '../../../modules/dispatch/route-batches/services/route-capacity.service.js';
import { MailerPort } from '../../../plugins/mailer/mailer.port.js';
import { formatNoticeDate, formatNoticeWindow } from '../../final-review/domain/notice-format.js';
import { PromiseFirmingService } from '../../promise-firming/services/promise-firming.service.js';
import { closeGap, layoutDestination, type CurrentStop } from '../domain/reschedule-layout.js';
import { parseSlotId, type RescheduleOffer } from '../domain/slot-offer.js';
import type { PublicTrackingDto } from '../dto/public-tracking.dto.js';
import {
    RescheduleNotAvailableException, SlotNoLongerAvailableException, VerificationRequiredException,
} from '../exceptions/index.js';
import { PublicTrackingService, assertCanReschedule, type TrackingContext } from './public-tracking.service.js';
import { SlotOfferService } from './slot-offer.service.js';
import { VerificationCodeService } from './verification-code.service.js';

/** Catalog code seeded for the rescheduling nobody executes: the customer's own (`reschedule_reasons`). */
export const CUSTOMER_RESCHEDULE_REASON_CODE = 'RES-CLI-SELF';

interface BatchLock {
    id: number;
    status: string;
    version: number;
    vehicle_id: number | null;
}

interface StopRow {
    dispatch_id: number;
    sequence_order: number | null;
    version: number;
    status: string;
    customer_confirmation: string;
    promise_firmed_at: Date | null;
    route_batch_id: number;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
}

interface Applied {
    rescheduleId: number;
    recordVersion: number;
    fromBatchId: number;
    originCancelled: boolean;
}

/**
 * The customer's rescheduling (ST-224.1, RF-U21, D-47, D-28, D-32).
 *
 * In ONE transaction the dispatch enters the batch the customer chose and then leaves the one it was in: both
 * batches are locked in id order and then their dispatches (the same order as the cutoff and the approvals,
 * ST-72.5), everything the offer relied on is checked again under the lock (versions, the stops of the destination,
 * the customer's state and attempts, the capacity of the vehicle), the dispatch version moves, the promise is
 * made firm (the first time) or its preparation order is replaced (afterwards) with a higher `recordVersion`,
 * and the movement is written to `dispatch_reschedules` (`customer`) and `route_batch_events`. If anything
 * fails nothing is left half done, and the customer keeps the slot they had.
 *
 * `promise_notified_at` is never touched: the 12 h of the customer do not start again. The routing engine is asked
 * BEFORE the transaction (an outage is a 503 with nothing to undo); the slot is looked up again, so the choice is
 * judged by the plan as it is now, not as the page saw it.
 */
@Injectable()
export class CustomerRescheduleService {
    private readonly logger = new Logger(CustomerRescheduleService.name);
    private readonly webUrl: string;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly tracking: PublicTrackingService,
        private readonly verification: VerificationCodeService,
        private readonly offers: SlotOfferService,
        private readonly firming: PromiseFirmingService,
        private readonly capacity: RouteCapacityService,
        private readonly mailer: MailerPort,
        config: ConfigService,
    ) {
        this.webUrl = config.get<string>('PUBLIC_WEB_URL', 'http://localhost:5173')!.replace(/\/$/, '');
    }

    async reschedule(token: string, slotId: string, proof: string | undefined, now: Date = new Date()): Promise<PublicTrackingDto> {
        const context = await this.tracking.resolve(token, now);
        assertCanReschedule(context);
        if (!(await this.verification.hasValidProof(context.dispatchId, proof))) throw new VerificationRequiredException();

        const choice = parseSlotId(slotId);
        if (!choice) throw new SlotNoLongerAvailableException();
        // The routing engine first, before anything is locked. The slot is matched by its date and time: that is what
        // the customer chose, and only one batch offers a given date and time.
        const { offers } = await this.offers.computeOffers(context.dispatchId, now);
        const offer = offers.find((candidate) => candidate.windowStart.getTime() === choice.windowStart.getTime());
        if (!offer) throw new SlotNoLongerAvailableException();

        const applied = await this.dataSource.transaction(async (manager) => await this.apply(manager, context, offer, now));

        // The proof is spent only now that the rescheduling happened. Failing to spend it must not undo it.
        await this.verification.consumeProof(context.dispatchId, proof).catch((error: unknown) => {
            this.logger.warn(`The proof of dispatch ${context.dispatchId} could not be spent (${error instanceof Error ? error.name : 'unknown error'}).`);
            return false;
        });
        await this.confirmByEmail(context, offer, token);
        this.logger.log(`Dispatch ${context.dispatchId} rescheduled by the customer (batch ${applied.fromBatchId} → ${offer.routeBatchId}, recordVersion ${applied.recordVersion}).`);
        return await this.tracking.view(token, now);
    }

    private async apply(manager: EntityManager, context: TrackingContext, offer: RescheduleOffer, now: Date): Promise<Applied> {
        const fromBatchId = context.row.route_batch_id;
        const toBatchId = offer.routeBatchId;
        if (fromBatchId === null || fromBatchId === toBatchId) throw new RescheduleNotAvailableException('no_route');

        // 1. Locks, in the order everyone else uses: batches by id, then dispatches by id.
        const batches: BatchLock[] = await manager.query(
            `SELECT route_batch_id AS id, status, version, vehicle_id
               FROM route_batches WHERE route_batch_id = ANY($1::int[]) ORDER BY route_batch_id FOR UPDATE`,
            [[fromBatchId, toBatchId]],
        );
        const from = batches.find((batch) => batch.id === fromBatchId);
        const to = batches.find((batch) => batch.id === toBatchId);
        if (!from || from.status !== RouteBatchStatusEnum.PROVISIONAL) throw new RescheduleNotAvailableException('batch_not_open');
        if (!to || to.status !== RouteBatchStatusEnum.PROVISIONAL || to.version !== offer.batchVersion || to.vehicle_id === null) {
            throw new SlotNoLongerAvailableException();
        }
        const stops: StopRow[] = await manager.query(
            `SELECT d.dispatch_id, d.sequence_order, d.version, s.name AS status, d.customer_confirmation,
                    d.promise_firmed_at, d.route_batch_id, d.scheduled_window_start, d.scheduled_window_end
               FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = ANY($1::int[])
              ORDER BY d.dispatch_id FOR UPDATE OF d`,
            [[fromBatchId, toBatchId]],
        );

        // 2. The customer's own dispatch must still be what the page showed.
        const own = stops.find((stop) => stop.dispatch_id === context.dispatchId);
        if (!own || own.route_batch_id !== fromBatchId || own.version !== context.version) throw new SlotNoLongerAvailableException();
        if (own.status !== 'scheduled' || !['pending', 'rescheduled'].includes(own.customer_confirmation)) {
            throw new RescheduleNotAvailableException('not_open');
        }
        const closesAt = context.selfService.windowClosesAt;
        if (!closesAt || now.getTime() >= closesAt.getTime()) throw new RescheduleNotAvailableException('window_elapsed');
        const maxAttempts = context.selfService.rescheduleAttemptsLeft + context.row.reschedule_attempts;
        const [{ used }]: { used: number }[] = await manager.query(
            `SELECT COUNT(*)::int AS used FROM dispatch_reschedules WHERE dispatch_id = $1 AND rescheduled_by_type = 'customer'`,
            [own.dispatch_id],
        );
        if (used >= maxAttempts) throw new RescheduleNotAvailableException('max_attempts');

        // 3. The destination must hold exactly the stops the route was simulated with.
        const current = (batchId: number): CurrentStop[] => stops
            .filter((stop) => stop.route_batch_id === batchId && stop.dispatch_id !== own.dispatch_id)
            .map((stop) => ({ dispatchId: stop.dispatch_id, sequence: stop.sequence_order, windowStart: stop.scheduled_window_start }));
        const layout = layoutDestination(offer.route, own.dispatch_id, offer.deliveryDate, current(toBatchId));
        if (!layout) throw new SlotNoLongerAvailableException();

        // 4. Enter the new batch...
        await manager.query(`UPDATE dispatches SET sequence_order = NULL WHERE route_batch_id = $1 AND sequence_order IS NOT NULL`, [toBatchId]);
        if (layout.others.length > 0) {
            await manager.query(
                `UPDATE dispatches AS d
                    SET sequence_order = v.seq, scheduled_window_start = v.ws, scheduled_window_end = v.we,
                        version = d.version + CASE WHEN v.bump THEN 1 ELSE 0 END,
                        updated_at = CASE WHEN v.bump THEN NOW() ELSE d.updated_at END
                   FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS seq, unnest($3::timestamptz[]) AS ws,
                                unnest($4::timestamptz[]) AS we, unnest($5::boolean[]) AS bump) AS v
                  WHERE d.dispatch_id = v.id`,
                [
                    layout.others.map((stop) => stop.dispatchId), layout.others.map((stop) => stop.sequence),
                    layout.others.map((stop) => stop.windowStart), layout.others.map((stop) => stop.windowEnd),
                    layout.others.map((stop) => stop.changed),
                ],
            );
        }
        // The move is a change of plan: the dispatch version goes up, and that is the `recordVersion` of the new order.
        await manager.query(
            `UPDATE dispatches
                SET route_batch_id = $2, sequence_order = $3, scheduled_window_start = $4, scheduled_window_end = $5,
                    version = version + 1, updated_at = NOW()
              WHERE dispatch_id = $1`,
            [own.dispatch_id, toBatchId, layout.own.sequence, layout.own.windowStart, layout.own.windowEnd],
        );
        await manager.query(`UPDATE route_batches SET version = version + 1, updated_at = NOW() WHERE route_batch_id = $1`, [toBatchId]);

        // ...and only then leave the old one, closing the gap (or cancelling it when it is left with nothing).
        const originCancelled = await this.leave(manager, fromBatchId, current(fromBatchId));

        // 5. Another order may have taken the room meanwhile without moving the batch version.
        try {
            await this.capacity.assertAssignable(toBatchId, to.vehicle_id, manager);
        } catch (error) {
            if (error instanceof RouteCapacityExceededException) throw new SlotNoLongerAvailableException();
            throw error;
        }

        // 6. The record of the movement, linked by the metadata.
        const [{ dispatch_reschedule_id: rescheduleId }]: { dispatch_reschedule_id: number }[] = await manager.query(
            `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by, rescheduled_by_type,
                    previous_route_batch_id, new_route_batch_id, previous_window_start, previous_window_end,
                    new_window_start, new_window_end)
             VALUES ($1, (SELECT reschedule_reason_id FROM reschedule_reasons WHERE code = $2), NULL, 'customer',
                     $3, $4, $5, $6, $7, $8)
             RETURNING dispatch_reschedule_id`,
            [
                own.dispatch_id, CUSTOMER_RESCHEDULE_REASON_CODE, fromBatchId, toBatchId,
                own.scheduled_window_start, own.scheduled_window_end, layout.own.windowStart, layout.own.windowEnd,
            ],
        );

        // 7. The promise: firm the first time (rescheduling is accepting, D-47), a new order afterwards. Never
        //    `promise_notified_at`: the 12 h do not start again.
        const wasFirm = own.promise_firmed_at !== null;
        const promise = wasFirm
            ? await this.firming.reissue(own.dispatch_id, { manager, now })
            : await this.firming.firm(own.dispatch_id, { reason: 'customer_rescheduled', now, manager });
        if (promise.outcome !== 'firmed' && promise.outcome !== 'reissued') {
            throw new RescheduleNotAvailableException(promise.outcome === 'incomplete' ? 'order_incomplete' : 'promise_not_firm');
        }
        await manager.query(`UPDATE dispatches SET customer_confirmation = 'rescheduled' WHERE dispatch_id = $1`, [own.dispatch_id]);

        await this.recordMovement(manager, {
            dispatchId: own.dispatch_id, rescheduleId, fromBatchId, toBatchId, recordVersion: promise.recordVersion,
            previousSequence: own.sequence_order, newSequence: layout.own.sequence,
            previousWindow: [own.scheduled_window_start, own.scheduled_window_end], newWindow: [layout.own.windowStart, layout.own.windowEnd],
            batchVersion: offer.batchVersion + 1,
            shiftedDispatchIds: layout.others.filter((stop) => stop.changed).map((stop) => stop.dispatchId),
            originCancelled, firmed: !wasFirm,
        });
        return { rescheduleId, recordVersion: promise.recordVersion, fromBatchId, originCancelled };
    }

    /** Takes the stop out of the old batch: the rest keep their order without a gap; a batch left empty is cancelled. */
    private async leave(manager: EntityManager, batchId: number, remaining: CurrentStop[]): Promise<boolean> {
        if (remaining.length === 0) {
            await manager.query(
                `UPDATE route_batches SET status = '${RouteBatchStatusEnum.CANCELLED}', version = version + 1, updated_at = NOW() WHERE route_batch_id = $1`,
                [batchId],
            );
            return true;
        }
        const placed = closeGap(remaining);
        await manager.query(`UPDATE dispatches SET sequence_order = NULL WHERE route_batch_id = $1 AND sequence_order IS NOT NULL`, [batchId]);
        await manager.query(
            `UPDATE dispatches AS d
                SET sequence_order = v.seq,
                    version = d.version + CASE WHEN v.bump THEN 1 ELSE 0 END,
                    updated_at = CASE WHEN v.bump THEN NOW() ELSE d.updated_at END
               FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS seq, unnest($3::boolean[]) AS bump) AS v
              WHERE d.dispatch_id = v.id`,
            [placed.map((stop) => stop.dispatchId), placed.map((stop) => stop.sequence), placed.map((stop) => stop.changed)],
        );
        await manager.query(`UPDATE route_batches SET version = version + 1, updated_at = NOW() WHERE route_batch_id = $1`, [batchId]);
        return false;
    }

    private async recordMovement(
        manager: EntityManager,
        data: {
            dispatchId: number; rescheduleId: number; fromBatchId: number; toBatchId: number; recordVersion: number;
            previousSequence: number | null; newSequence: number; previousWindow: (Date | null)[]; newWindow: Date[];
            batchVersion: number; shiftedDispatchIds: number[]; originCancelled: boolean; firmed: boolean;
        },
    ): Promise<void> {
        const metadata = JSON.stringify({
            dispatchId: data.dispatchId,
            rescheduleId: data.rescheduleId,
            fromBatchId: data.fromBatchId,
            toBatchId: data.toBatchId,
            previousSequence: data.previousSequence,
            newSequence: data.newSequence,
            previousWindowStart: data.previousWindow[0], previousWindowEnd: data.previousWindow[1],
            newWindowStart: data.newWindow[0], newWindowEnd: data.newWindow[1],
            recordVersion: data.recordVersion,
            batchVersion: data.batchVersion,
            shiftedDispatchIds: data.shiftedDispatchIds,
            fromBatchCancelled: data.originCancelled,
            promiseFirmedByThisRescheduling: data.firmed,
        });
        await manager.query(
            `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_type, reason, metadata)
             VALUES ($1, $2, 'customer_rescheduled', 'customer', 'Customer rescheduled the delivery from the tracking link', $3::jsonb)`,
            [data.toBatchId, data.dispatchId, metadata],
        );
        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             VALUES ($1, 'moved_between_batches', 'customer', 'customer_reschedule', $2::jsonb)`,
            [data.dispatchId, metadata],
        );
        if (data.originCancelled) {
            await manager.query(
                `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_type, reason, metadata)
                 VALUES ($1, NULL, 'cancelled', 'customer', 'customer_rescheduled_emptied', $2::jsonb)`,
                [data.fromBatchId, JSON.stringify({ lastDispatchId: data.dispatchId, toBatchId: data.toBatchId, rescheduleId: data.rescheduleId })],
            );
        }
    }

    /** The customer gets the slot they chose in writing. A failure here must not undo what was already committed. */
    private async confirmByEmail(context: TrackingContext, offer: RescheduleOffer, token: string): Promise<void> {
        const email = context.row.contact_email;
        if (!email) return;
        try {
            const result = await this.mailer.send({
                to: email,
                subject: 'Tu entrega fue reprogramada',
                template: 'promise',
                context: {
                    deliveryDate: formatNoticeDate(offer.windowStart),
                    deliveryWindow: formatNoticeWindow(offer.windowStart, offer.windowEnd),
                    trackingUrl: `${this.webUrl}/seguimiento/${token}`,
                },
                metadata: { dispatchId: context.dispatchId, routeBatchId: offer.routeBatchId },
            });
            if (result.status === 'sent') {
                await this.dataSource.query(
                    `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
                     VALUES ($1, 'reschedule_confirmation_sent', 'system', 'Email with the new slot accepted by the mail transport', $2::jsonb)`,
                    [context.dispatchId, JSON.stringify({ routeBatchId: offer.routeBatchId, template: 'promise' })],
                );
            }
        } catch {
            this.logger.warn(`The confirmation email of the rescheduling of dispatch ${context.dispatchId} could not be sent.`);
        }
    }
}
