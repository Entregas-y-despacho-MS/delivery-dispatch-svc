import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests } from '../../../shared/utils/swagger/index.js';
import { Roles } from '../../auth/decorators/index.js';
import { FleetReportsParamsDto } from '../dto/fleet-reports-params.dto.js';
import { FleetReportsDto } from '../dto/fleet-reports.dto.js';
import { FleetReportsService } from '../services/fleet-reports.service.js';

@ApiTags('Fleet Reports')
@ApiBearerAuth('access-token')
@Controller('fleet/reports')
export class FleetReportsController {
    constructor(private readonly reports: FleetReportsService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'Fleet report by date range',
        description: 'Returns driver and vehicle delivery metrics for closed dispatches, with maintenance count and Bolivia calendar days on each vehicle row. The range is inclusive, must not exceed 366 days, and both dates use YYYY-MM-DD. Maintenance rows overlapping the range are counted; open maintenance counts through `to`. The complete response is cached for 10 minutes. Redis failures fall back to PostgreSQL. Requires coordinator or supervisor role, or root.',
    })
    @ApiOkResponse({ type: FleetReportsDto })
    @ApiBadRequests({
        validation: true,
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'to' parameter must be a valid date in YYYY-MM-DD format."],
        errors: [
            { code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." },
            { code: 'DATE_RANGE_TOO_LARGE', message: 'The date range must not exceed 366 days.' },
        ],
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or expired token.' })
    @ApiForbiddenResponse({ description: 'The user does not have coordinator or supervisor permissions.' })
    async getReport(@Query() params: FleetReportsParamsDto): Promise<FleetReportsDto> {
        return await this.reports.get(params.from, params.to);
    }
}
