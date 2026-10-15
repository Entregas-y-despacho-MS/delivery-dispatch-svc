import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoordinatorOnly } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';
import { PickupRescheduleDto, PickupScheduleDto } from '../dto/pickup-schedule.dto.js';
import { SchedulePickupDto } from '../dto/schedule-pickup.dto.js';
import { ReschedulePickupDto } from '../dto/reschedule-pickup.dto.js';
import { InvalidPickupWindowException } from '../exceptions/index.js';
import { PickupSchedulingService } from '../services/pickup-scheduling.service.js';

/**
 * ERP-04 — scheduling of supplier pickups ("recogida en proveedor").
 *
 * Error dictionary: VALIDATION_FAILED 400 | INVALID_PICKUP_WINDOW 400 | INVALID_TOKEN 401 |
 * INSUFFICIENT_PERMISSIONS 403 | DISPATCH_NOT_FOUND 404 | VEHICLE_NOT_FOUND 404 |
 * INCIDENT_REASON_NOT_FOUND 404 | RESCHEDULE_REASON_NOT_FOUND 404 | DISPATCH_NOT_SCHEDULABLE 409 |
 * SUPPLIER_PICKUP_INCOMPLETE 409 | PICKUP_WINDOWS_DO_NOT_INTERSECT 409 | PICKUP_WINDOW_NOT_AVAILABLE 409 |
 * PICKUP_CAPACITY_EXCEEDED 409 | PICKUP_RESCHEDULE_OUT_OF_RANGE 409.
 */
@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class PickupSchedulingController {
    constructor(private readonly service: PickupSchedulingService) {}

    @Post(':id/pickup-schedule')
    @HttpCode(HttpStatus.OK)
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Schedule a supplier pickup',
        description: 'Agrees the date and time slot of a `supplier_pickup` dispatch and tells Compras (ERP-04). The dispatch must be `pending` and have its pickup address, destination warehouse and supplier schedule complete; a request in `address_review` or with missing data answers 409 `SUPPLIER_PICKUP_INCOMPLETE`. The service window is the intersection of the supplier schedule and the reception hours of the destination warehouse (the general delivery window of ES-57 when the catalog defines none), in America/La_Paz; with no common time still ahead it answers 409 `PICKUP_WINDOWS_DO_NOT_INTERSECT`. `windowStart` and `windowEnd` pick a slot inside that intersection; when omitted, the earliest slot ahead is taken. The estimated weight and volume of the pickup are compared with the capacity of `vehicleId`; exceeding it answers 409 `PICKUP_CAPACITY_EXCEEDED`. On success the dispatch becomes `scheduled`, the agreed slot replaces `scheduled_window_*` (the supplier schedule is kept in the event log), the transfer code is assigned if the dispatch had none, and the message `dispatch.pickup.scheduled` (date, slot and purchase order) is written to the outbox in the same transaction. Requires the coordinator role (or root).',
    })
    @ApiIdParam('Dispatch')
    @ApiOkResponse({ type: PickupScheduleDto })
    @ApiBadRequests({
        validation: true, id: true,
        errors: [{ code: 'INVALID_PICKUP_WINDOW', message: 'windowStart and windowEnd must be sent together.' }],
        example: ['vehicleId must be an integer.'],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound(
        { code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' },
        { code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' },
    )
    @ApiConflict(
        { code: 'DISPATCH_NOT_SCHEDULABLE', message: 'A supplier pickup can only be scheduled while it is pending (current status: scheduled).' },
        { code: 'SUPPLIER_PICKUP_INCOMPLETE', message: 'The supplier pickup cannot be scheduled: missing destination warehouse.' },
        { code: 'PICKUP_WINDOWS_DO_NOT_INTERSECT', message: 'The supplier pickup window and the warehouse reception hours have no common time still ahead.' },
        { code: 'PICKUP_WINDOW_NOT_AVAILABLE', message: 'The requested pickup window does not fall inside the supplier window and the warehouse reception hours.' },
        { code: 'PICKUP_CAPACITY_EXCEEDED', message: 'The estimated load exceeds the vehicle capacity: weight 1200 kg over 1000 kg.' },
    )
    async schedule(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: SchedulePickupDto,
        @CurrentUser('id') userId: number,
    ): Promise<PickupScheduleDto> {
        const window = this.toWindow(dto.windowStart, dto.windowEnd);
        return await this.service.schedule(id, { vehicleId: dto.vehicleId, window }, userId);
    }

    @Post(':id/pickup-reschedule')
    @HttpCode(HttpStatus.OK)
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Reschedule a supplier pickup because the supplier was unavailable',
        description: 'Registers that the supplier did not have the load ready and moves the pickup to a new slot (ERP-04, scenario 2). The dispatch must be `scheduled` and stays `scheduled`. The new slot must fall inside the reception hours of the destination warehouse, be later than the current one and start at most `reschedule_window_days` (ES-57) days after it. In one transaction it records the incident, writes the `dispatch_reschedules` row (`rescheduled_by_type = coordinator`, with the previous and the new slot), replaces `scheduled_window_*`, and writes to the outbox `dispatch.transfer.incident_reported` and a new `dispatch.pickup.scheduled`, both with the `recordVersion` incremented. Requires the coordinator role (or root).',
    })
    @ApiIdParam('Dispatch')
    @ApiOkResponse({ type: PickupRescheduleDto })
    @ApiBadRequests({
        validation: true, id: true,
        errors: [{ code: 'INVALID_PICKUP_WINDOW', message: 'windowEnd must be later than windowStart.' }],
        example: ['incidentReasonId must be an integer.', 'windowStart must be an ISO-8601 date and time with an offset, e.g. 2026-10-20T14:00:00Z.'],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound(
        { code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' },
        { code: 'INCIDENT_REASON_NOT_FOUND', message: 'Incident reason not found.' },
        { code: 'RESCHEDULE_REASON_NOT_FOUND', message: 'Reschedule reason not found.' },
    )
    @ApiConflict(
        { code: 'DISPATCH_NOT_SCHEDULABLE', message: 'A supplier pickup can only be rescheduled while it is scheduled (current status: pending).' },
        { code: 'PICKUP_WINDOW_NOT_AVAILABLE', message: 'The requested pickup window does not fall inside the supplier window and the warehouse reception hours.' },
        { code: 'PICKUP_RESCHEDULE_OUT_OF_RANGE', message: 'The new pickup cannot start more than 2 day(s) after the current one, and must be later than it.' },
    )
    async reschedule(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: ReschedulePickupDto,
        @CurrentUser('id') userId: number,
    ): Promise<PickupRescheduleDto> {
        const window = this.toWindow(dto.windowStart, dto.windowEnd)!;
        return await this.service.reschedule(
            id,
            {
                incidentReasonId: dto.incidentReasonId,
                rescheduleReasonId: dto.rescheduleReasonId,
                window,
                description: dto.description ?? null,
            },
            userId,
        );
    }

    /** `windowStart` and `windowEnd` travel together; both missing means the service picks the slot. */
    private toWindow(start?: string, end?: string): { startsAt: Date; endsAt: Date } | undefined {
        if (start === undefined && end === undefined) return undefined;
        if (start === undefined || end === undefined) {
            throw new InvalidPickupWindowException('windowStart and windowEnd must be sent together.');
        }
        const startsAt = new Date(start);
        const endsAt = new Date(end);
        if (endsAt.getTime() <= startsAt.getTime()) {
            throw new InvalidPickupWindowException('windowEnd must be later than windowStart.');
        }
        return { startsAt, endsAt };
    }
}
