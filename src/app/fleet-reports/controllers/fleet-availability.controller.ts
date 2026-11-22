import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests } from '../../../shared/utils/swagger/index.js';
import { Roles } from '../../auth/decorators/index.js';
import { FleetAvailabilityParamsDto } from '../dto/fleet-availability-params.dto.js';
import { FleetAvailabilityDto } from '../dto/fleet-availability.dto.js';
import { FleetAvailabilityService } from '../services/fleet-availability.service.js';

/**
 * Error dictionary: CUTOFF_IN_FUTURE 400, INVALID_DATE_RANGE 400, DATE_RANGE_TOO_LARGE 400,
 *   DRIVER_DETAIL_FORBIDDEN 403, INSUFFICIENT_PERMISSIONS 403, INVALID_TOKEN 401
 */
@ApiTags('Fleet Reports')
@ApiBearerAuth('access-token')
@Controller('fleet/availability')
export class FleetAvailabilityController {
    constructor(private readonly availability: FleetAvailabilityService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'Fleet availability, maintenance, load and productivity',
        description: 'Availability at a cut-off day (assignable / registered active vehicles, apart from maintenance and out of service), maintenance and calendar days of the period (overlapping intervals of one vehicle are merged and flagged), load per vehicle in kg and m³ kept apart (only from approved routes), and deliveries and attempts by driver (`n` everywhere). Only the current vehicle status is stored, so a past cut-off answers the availability as `N/D` (null with its reason); it is never a historical availability by hours. `from`/`to` default to the cut-off day. The maintenance filters (`maintenanceTypeId`, `routine`) narrow the maintenance figures, not the list of vehicles; `fleetStatus` narrows the list and not the availability summary. The driver detail (`productivity.drivers`, `driverId`) is only for supervisor and root: other roles get the aggregate and `detailRestricted: true`, decided on the server. Requires coordinator or supervisor role, or root.',
    })
    @ApiOkResponse({ type: FleetAvailabilityDto })
    @ApiBadRequests({
        validation: true,
        example: ["The 'cutoff' parameter must be a valid date in YYYY-MM-DD format.", "The 'fleetStatus' parameter must be one of: active, maintenance, out_of_service."],
        errors: [
            { code: 'CUTOFF_IN_FUTURE', message: "The 'cutoff' date must not be after today (Bolivia)." },
            { code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." },
            { code: 'DATE_RANGE_TOO_LARGE', message: 'The date range must not exceed 366 days.' },
        ],
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or expired token.' })
    @ApiForbiddenResponse({ description: 'The user does not have coordinator or supervisor permissions (INSUFFICIENT_PERMISSIONS), or asked for a driver while the role may only see aggregates (DRIVER_DETAIL_FORBIDDEN).' })
    async get(@Query() params: FleetAvailabilityParamsDto, @CurrentUser('role') role: string): Promise<FleetAvailabilityDto> {
        return await this.availability.get(params, role);
    }
}
