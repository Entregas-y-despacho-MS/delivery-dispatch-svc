import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PromiseFirmingService } from '../../promise-firming/services/promise-firming.service.js';
import { DispatchStatusEnum } from '../../../shared/enums/index.js';
import type { PublicTrackingDto } from '../dto/public-tracking.dto.js';
import { ChangeRequestNotAvailableException, ConfirmationNotAvailableException } from '../exceptions/index.js';
import { PublicTrackingService, type TrackingContext } from './public-tracking.service.js';

/** States in which a coordinator can still evaluate a change (the same as `evaluateSelfService`). */
const CHANGE_REQUEST_STATUSES: string[] = [DispatchStatusEnum.SCHEDULED, DispatchStatusEnum.ASSIGNED];

/**
 * The two answers a customer can give from the link without choosing a new slot (ST-224.1, RF-U21):
 * confirm the promise, or leave a change request for the coordinator.
 *
 * Confirming goes through `PromiseFirmingService.firm` (ST-215.4): promise firm, `promise_firmed` event and the
 * preparation order in ONE transaction, with the single-emission guard, so a click racing the 12 h timer or
 * a second click can never queue two orders. Asking for a change moves nothing: it marks the delivery
 * `change_requested` and keeps what the customer wrote as an event, and the coordinator decides (a later
 * rescheduling of ES-52 resolves it).
 */
@Injectable()
export class CustomerResponseService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly tracking: PublicTrackingService,
        private readonly firming: PromiseFirmingService,
    ) {}

    async confirm(token: string, now: Date = new Date()): Promise<PublicTrackingDto> {
        const context = await this.tracking.resolve(token, now);
        if (!context.selfService.canConfirm) throw new ConfirmationNotAvailableException(this.cannotConfirmReason(context));

        const result = await this.firming.firm(context.dispatchId, { reason: 'customer_confirmed', now });
        // `already_firmed` means a parallel click (or the timer) got there first: the customer's goal is met.
        if (result.outcome === 'incomplete') throw new ConfirmationNotAvailableException('order_incomplete');
        if (result.outcome === 'not_eligible') throw new ConfirmationNotAvailableException(result.cause);
        return await this.tracking.view(token, now);
    }

    async requestChange(token: string, detail: string, now: Date = new Date()): Promise<PublicTrackingDto> {
        const context = await this.tracking.resolve(token, now);
        if (!context.selfService.canRequestChange) throw new ChangeRequestNotAvailableException(this.cannotRequestReason(context));

        await this.dataSource.transaction(async (manager) => {
            const [current]: { status: string; customer_confirmation: string }[] = await manager.query(
                `SELECT ds.name AS status, d.customer_confirmation
                   FROM dispatches d JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
                  WHERE d.dispatch_id = $1
                    FOR UPDATE OF d`,
                [context.dispatchId],
            );
            if (!current || !CHANGE_REQUEST_STATUSES.includes(current.status)) throw new ChangeRequestNotAvailableException('not_open');
            if (current.customer_confirmation === 'change_requested') throw new ChangeRequestNotAvailableException('change_requested');

            // `version` stays: nothing in the plan moved. The batch and the promise are exactly as they were.
            await manager.query(
                `UPDATE dispatches SET customer_confirmation = 'change_requested', updated_at = NOW() WHERE dispatch_id = $1`,
                [context.dispatchId],
            );
            await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, detail, metadata)
                 VALUES ($1, 'change_requested', 'customer', $2, $3, $4::jsonb)`,
                [
                    context.dispatchId,
                    'Customer asked for a change from the tracking link',
                    detail,
                    JSON.stringify({
                        previousCustomerConfirmation: current.customer_confirmation,
                        selfServiceOpen: context.selfService.open,
                        selfServiceClosedReason: context.selfService.closedReason,
                        status: current.status,
                    }),
                ],
            );
        });
        return await this.tracking.view(token, now);
    }

    private cannotConfirmReason({ selfService, row }: TrackingContext): string {
        if (selfService.closedReason) return selfService.closedReason;
        // Open but not pending: a rescheduling already made the promise firm.
        return row.customer_confirmation === 'rescheduled' ? 'rescheduled' : 'customer_response_recorded';
    }

    private cannotRequestReason({ selfService, row }: TrackingContext): string {
        return row.customer_confirmation === 'change_requested' ? 'change_requested' : selfService.closedReason ?? 'not_open';
    }
}
