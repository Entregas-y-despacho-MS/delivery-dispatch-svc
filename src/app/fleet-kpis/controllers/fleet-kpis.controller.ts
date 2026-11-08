import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { Roles } from '../../auth/decorators/index.js';
import { FleetKpisParamsDto } from '../dto/fleet-kpis-params.dto.js';
import { FleetKpisDto } from '../dto/fleet-kpis.dto.js';
import { FleetKpisService } from '../services/fleet-kpis.service.js';

/**
 * ST-61.1 (RF-A14) — fleet KPIs.
 *
 * Error dictionary: VALIDATION_FAILED 400 (missing or invalid `period`) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403
 */
@ApiTags('Fleet KPIs')
@ApiBearerAuth('access-token')
@Controller('fleet/kpis')
export class FleetKpisController {
    constructor(private readonly kpis: FleetKpisService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'Performance indicators of the fleet for a period, by driver and by vehicle',
        description: "For `today`, `week` (Monday to today) or `month` (the 1st to today), in Bolivia days, returns the SLA figures of the delivery dispatches closed in the period (see `GET /reports/sla`): `totals` for the cards (dispatches closed, on-time percentage, incidents), `drivers` for the ranking and `vehicles` (by plate) for the bars. It reuses the SLA aggregation, so incidents include the company failures (`INC-COMP-FAILURE`). Each grouping is cached in Redis for 10 minutes, nothing invalidates it, and if Redis does not answer it is computed from PostgreSQL. A period without closed dispatches comes with empty lists and zeros. Requires coordinator or supervisor role, or root.",
    })
    @ApiOkResponse({ type: FleetKpisDto })
    @ApiBadRequests({ validation: true, example: ["The 'period' parameter must be one of: today, week, month."] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getKpis(@Query() params: FleetKpisParamsDto): Promise<FleetKpisDto> {
        return await this.kpis.get(params.period);
    }
}
