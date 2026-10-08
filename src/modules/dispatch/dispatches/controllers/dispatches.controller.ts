import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DispatchesService } from '../services/dispatches.service.js';
import { FindDriverAssignmentsParamsDto } from '../dto/find-driver-assignments-params.dto.js';
import { DriverAssignmentsResponseDto } from '../dto/driver-assignments-response.dto.js';
import { todayInOperatingTimeZone } from '../utils/operating-date.util.js';
import { DriverOnly } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';

/**
 * RF-U02 — "Mi Jornada": the stops the driver has to visit today, in the order Dispatch decided.
 *
 * Error dictionary: VALIDATION_FAILED 400 (invalid `date`) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class DispatchesController {
    constructor(private readonly dispatchesService: DispatchesService) {}

    @Get('my-assignments')
    @DriverOnly()
    @ApiOperation({
        summary:     "List the driver's assigned stops for a shift (default: today)",
        description: "Returns the dispatches of the route assigned to the authenticated driver for the given day, ordered by `sequenceOrder` (the driver cannot reorder them). The driver is always taken from the token, never from a parameter, so nobody can read another driver's route. Stops already closed that day are included. A driver with no route that day gets an empty `data` list (200), not an error. `lastModifiedAt` is the newest change among the stops: the mobile app compares it with its local copy on pull-to-refresh to tell the route was modified. `date` defaults to today in America/La_Paz. Requires the driver role (or root).",
    })
    @ApiOkResponse({ type: DriverAssignmentsResponseDto })
    @ApiBadRequests({ validation: true, example: ['date must be a valid date in YYYY-MM-DD format.'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findMyAssignments(@Query() params: FindDriverAssignmentsParamsDto, @CurrentUser('id') driverId: number): Promise<DriverAssignmentsResponseDto> {
        return await this.dispatchesService.findDriverAssignments(driverId, params.date ?? todayInOperatingTimeZone());
    }
}
