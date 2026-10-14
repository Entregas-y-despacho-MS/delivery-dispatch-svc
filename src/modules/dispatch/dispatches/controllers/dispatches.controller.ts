import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DispatchesService } from '../services/dispatches.service.js';
import { DispatchPriorityService } from '../services/dispatch-priority.service.js';
import { FindDriverAssignmentsParamsDto } from '../dto/find-driver-assignments-params.dto.js';
import { DriverAssignmentsResponseDto } from '../dto/driver-assignments-response.dto.js';
import { UpdateDispatchPriorityDto } from '../dto/update-dispatch-priority.dto.js';
import { DispatchPriorityDto } from '../dto/dispatch-priority.dto.js';
import { todayInOperatingTimeZone } from '../utils/operating-date.util.js';
import { DriverOnly, Roles } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';

/**
 * RF-U02 — "Mi Jornada": the stops the driver has to visit today, in the order Dispatch decided.
 * RF-A11 — manual change of a dispatch's priority.
 *
 * Error dictionary: VALIDATION_FAILED 400 (invalid `date` / `priority` / `:id`) | INVALID_TOKEN 401 |
 * INSUFFICIENT_PERMISSIONS 403 | DISPATCH_NOT_FOUND 404 | DISPATCH_PRIORITY_NOT_CHANGEABLE 409.
 */
@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class DispatchesController {
    constructor(
        private readonly dispatchesService: DispatchesService,
        private readonly priorityService: DispatchPriorityService,
    ) {}

    @Get('my-assignments')
    @DriverOnly()
    @ApiOperation({
        summary:     "List the driver's assigned stops for a shift (default: today)",
        description: "Returns the dispatches of the route assigned to the authenticated driver for the given day, ordered by `sequenceOrder` (the driver cannot reorder them). Only routes already confirmed by the coordinator (`confirmed`) or in execution (`in_execution`) are returned: provisional or under-review routes are never visible to the driver. Each stop carries its `trackingCode`, `evidencePolicy` (what evidence must be captured), `dispatchType`, `deliveryReference`, its `packages` (id, size and weight) and its `routeBatch` (`id`, `status`, `acceptedAt`). The driver is always taken from the token, never from a parameter, so nobody can read another driver's route. Stops already closed that day are included. A driver with no route that day gets an empty `data` list (200), not an error. `lastModifiedAt` is the newest change among the stops: the mobile app compares it with its local copy on pull-to-refresh to tell the route was modified. `date` defaults to today in America/La_Paz. Requires the driver role (or root).",
    })
    @ApiOkResponse({ type: DriverAssignmentsResponseDto })
    @ApiBadRequests({ validation: true, example: ['date must be a valid date in YYYY-MM-DD format.'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findMyAssignments(@Query() params: FindDriverAssignmentsParamsDto, @CurrentUser('id') driverId: number): Promise<DriverAssignmentsResponseDto> {
        return await this.dispatchesService.findDriverAssignments(driverId, params.date ?? todayInOperatingTimeZone());
    }

    @Patch(':id/priority')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Change the priority of a dispatch (urgent / normal)',
        description: "Marks a dispatch as `urgent` or back to `normal` (RF-A11). Only allowed while the dispatch is `pending`, `in_planning` or `scheduled`; in any other status it answers 409. The change is recorded in the dispatch's event log (`priority_changed`) with the user who made it. `urgent` only moves the order to the front of the queue of free capacity (the inbox lists urgent orders first, then by SLA deadline): it does not change the deadline, the delivery window or the 12 h customer window, and it does not displace promises already approved (D-15). Sending the priority the dispatch already has answers 200 and changes nothing. Requires coordinator or supervisor role, or root.",
    })
    @ApiIdParam('Dispatch')
    @ApiOkResponse({ type: DispatchPriorityDto })
    @ApiBadRequests({ validation: true, id: true, example: ["The 'priority' field must be one of: urgent, normal."] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict({ code: 'DISPATCH_PRIORITY_NOT_CHANGEABLE', message: 'The priority of a dispatch can only be changed while it is pending, in planning or scheduled (current status: assigned).' })
    async changePriority(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: UpdateDispatchPriorityDto,
        @CurrentUser('id') userId: number,
    ): Promise<DispatchPriorityDto> {
        return await this.priorityService.changePriority(id, dto.priority, userId);
    }
}
