import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../../dispatch-status/dispatch-status-changed.event.js';
import { buildTimeSlots, type TimeSlot } from '../../planning/domain/time-slots.js';
import { DISPATCH_RESCHEDULED_EVENT, type DispatchRescheduledEvent } from '../dispatch-rescheduled.event.js';
import { RescheduleDispatchResultDto } from '../dto/reschedule-dispatch-result.dto.js';
import type { RescheduleDispatchDto } from '../dto/reschedule-dispatch.dto.js';
import { isReschedulableStatus } from '../domain/reschedulable-status.js';
import { checkRescheduleWindow, type RescheduleWindowProblem } from '../domain/reschedule-window.js';
import {
    DispatchStatusNotReschedulableException,
    DispatchTypeNotSupportedException,
    InvalidRescheduleWindowException,
    RescheduleAttemptsLimitReachedException,
    RescheduleReasonInvalidException,
} from '../exceptions/index.js';
import { BatchExitService } from './batch-exit.service.js';
import { DeliveryAttemptsService } from './delivery-attempts.service.js';
import { DispatchLockService } from './dispatch-lock.service.js';

const WINDOW_MESSAGES: Record<RescheduleWindowProblem, string> = {
    'past-date': 'The agreed date cannot be before today.',
    'end-not-after-start': 'windowEnd must be later than windowStart.',
    'not-same-day': 'The slot must start and end on the same day (Bolivia time).',
    'not-a-slot': 'The window must be exactly one of the delivery slots (morning_window_* and afternoon_window_* cut every slot_duration_minutes), with no seconds.',
};

interface Applied {
    result: RescheduleDispatchResultDto;
    status: DispatchStatusChangedEvent;
    rescheduled: DispatchRescheduledEvent;
}

/**
 * Rescheduling of a delivery by the coordinator (ST-52.2, RF-A05, ES-52).
 *
 * In ONE transaction: the dispatch and its batch are locked and the state is judged under the lock, the delivery
 * attempts already spent are counted (D-30), the change is written to `dispatch_reschedules` (`coordinator`, previous
 * and new window, previous batch and the user), the dispatch leaves its batch according to the state of the batch
 * (`BatchExitService`), becomes `rescheduled` with the new agreed window in `scheduled_window_*` (the inbox reads it
 * there; the planner reads the one of `dispatch_reschedules`, so both are written), and the event is recorded.
 * After the commit `dispatch.status_changed` and `dispatch.rescheduled` (the notice to the customer, ES-40) are emitted.
 *
 * It does not firm the promise nor send a preparation order: a `rescheduled` dispatch has no batch and so no
 * departure date to put in it (see PENDIENTES.md).
 */
@Injectable()
export class DispatchReschedulingService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly locks: DispatchLockService,
        private readonly attempts: DeliveryAttemptsService,
        private readonly batchExit: BatchExitService,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly settings: SettingsService,
        private readonly events: EventEmitter2,
    ) {}

    async reschedule(dispatchId: number, dto: RescheduleDispatchDto, userId: number, now: Date = new Date()): Promise<RescheduleDispatchResultDto> {
        const windowStart = new Date(dto.windowStart);
        const windowEnd = new Date(dto.windowEnd);
        const check = checkRescheduleWindow(windowStart, windowEnd, now, await this.loadSlots());
        if (!check.ok) throw new InvalidRescheduleWindowException(WINDOW_MESSAGES[check.problem]);

        const applied = await this.dataSource.transaction(
            async (manager) => await this.apply(manager, dispatchId, dto, userId, { windowStart, windowEnd, shift: check.shift }),
        );

        // After the commit, so the socket and the customer notice never observe a rescheduling that rolled back.
        this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, applied.status);
        this.events.emit(DISPATCH_RESCHEDULED_EVENT, applied.rescheduled);
        return applied.result;
    }

    private async loadSlots(): Promise<TimeSlot[]> {
        const morning = {
            start: await this.settings.getString('morning_window_start', '09:00'),
            end: await this.settings.getString('morning_window_end', '13:00'),
        };
        const afternoon = {
            start: await this.settings.getString('afternoon_window_start', '14:00'),
            end: await this.settings.getString('afternoon_window_end', '18:00'),
        };
        return buildTimeSlots(morning, afternoon, await this.settings.getNumber('slot_duration_minutes', 120));
    }

    private async apply(
        manager: EntityManager,
        dispatchId: number,
        dto: RescheduleDispatchDto,
        userId: number,
        slot: { windowStart: Date; windowEnd: Date; shift: string },
    ): Promise<Applied> {
        const { dispatch, batch } = await this.locks.lock(manager, dispatchId);
        if (dispatch.type !== 'delivery') throw new DispatchTypeNotSupportedException(dispatch.type);
        if (!isReschedulableStatus(dispatch.status)) throw new DispatchStatusNotReschedulableException(dispatch.status);

        const attempts = await this.attempts.count(manager, dispatchId);
        if (attempts.limitReached) throw new RescheduleAttemptsLimitReachedException(attempts.used, attempts.limit);

        const [reason]: { reschedule_reason_id: number }[] = await manager.query(
            `SELECT reschedule_reason_id FROM reschedule_reasons WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
            [dto.reasonCode],
        );
        if (!reason) throw new RescheduleReasonInvalidException(dto.reasonCode);

        const [{ dispatch_reschedule_id: rescheduleId }]: { dispatch_reschedule_id: number }[] = await manager.query(
            `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by, rescheduled_by_type,
                    previous_route_batch_id, new_route_batch_id, previous_window_start, previous_window_end,
                    new_window_start, new_window_end)
             VALUES ($1, $2, $3, 'coordinator', $4, NULL, $5, $6, $7, $8)
             RETURNING dispatch_reschedule_id`,
            [dispatchId, reason.reschedule_reason_id, userId, dispatch.routeBatchId, dispatch.scheduledWindowStart, dispatch.scheduledWindowEnd, slot.windowStart, slot.windowEnd],
        );

        // Leaving the batch moves the dispatch version; with no batch there is nothing to leave, so it moves here.
        let bumpVersion = 1;
        let batchMetadata: Record<string, unknown> = {};
        if (batch) {
            const exit = await this.batchExit.leave(manager, batch, dispatchId, {
                actorUserId: userId,
                reason: 'Coordinator rescheduled the delivery',
                metadata: { cause: 'coordinator_rescheduled', rescheduleId, reasonCode: dto.reasonCode },
            });
            bumpVersion = 0;
            batchMetadata = { fromBatchId: exit.batchId, batchStatusBefore: exit.batchStatusBefore, batchStatusAfter: exit.batchStatusAfter, batchVersion: exit.batchVersion };
        }

        // `closed_at` stays NULL: `rescheduled` is not terminal and the trigger clears it. A pending change request
        // of the customer is resolved by this rescheduling (the comment of CustomerResponseService).
        const [updatedRows]: [{ version: number; updated_at: Date }[], number] = await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    scheduled_window_start = $3, scheduled_window_end = $4,
                    customer_confirmation = CASE WHEN customer_confirmation = 'change_requested' THEN 'rescheduled' ELSE customer_confirmation END,
                    version = version + $5, updated_at = NOW()
              WHERE dispatch_id = $1
              RETURNING version, updated_at`,
            [dispatchId, DispatchStatusEnum.RESCHEDULED, slot.windowStart, slot.windowEnd, bumpVersion],
        );
        const updated = updatedRows[0];

        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: `${dispatch.status} -> ${DispatchStatusEnum.RESCHEDULED}`,
            actorUserId: userId,
            actorType: 'user',
            reason: 'Coordinator rescheduled the delivery',
            metadata: {
                previousStatus: dispatch.status,
                status: DispatchStatusEnum.RESCHEDULED,
                version: updated.version,
                rescheduleId,
                reasonCode: dto.reasonCode,
                previousWindowStart: dispatch.scheduledWindowStart,
                previousWindowEnd: dispatch.scheduledWindowEnd,
                windowStart: slot.windowStart,
                windowEnd: slot.windowEnd,
                shift: slot.shift,
                attemptsUsed: attempts.used,
                attemptsLimit: attempts.limit,
                customerChangeRequestResolved: dispatch.customerConfirmation === 'change_requested',
                instructions: dto.instructions ?? null,
                ...batchMetadata,
            },
        }, { manager });

        return {
            result: {
                dispatchId,
                status: DispatchStatusEnum.RESCHEDULED,
                rescheduleId,
                version: updated.version,
                windowStart: slot.windowStart.toISOString(),
                windowEnd: slot.windowEnd.toISOString(),
                shift: slot.shift,
                attemptsUsed: attempts.used,
                attemptsLimit: attempts.limit,
            },
            status: {
                dispatchId,
                status: DispatchStatusEnum.RESCHEDULED,
                previousStatus: dispatch.status,
                version: updated.version,
                updatedAt: new Date(updated.updated_at).toISOString(),
            },
            rescheduled: {
                dispatchId,
                rescheduleId,
                rescheduledBy: 'coordinator',
                reasonCode: dto.reasonCode,
                previousStatus: dispatch.status,
                previousWindowStart: dispatch.scheduledWindowStart?.toISOString() ?? null,
                previousWindowEnd: dispatch.scheduledWindowEnd?.toISOString() ?? null,
                windowStart: slot.windowStart.toISOString(),
                windowEnd: slot.windowEnd.toISOString(),
                version: updated.version,
            },
        };
    }
}
