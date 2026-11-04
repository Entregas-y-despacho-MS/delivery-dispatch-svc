import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { CoordinatorOnly } from '../../auth/decorators/index.js';
import { SlaReportParamsDto } from '../dto/sla-report-params.dto.js';
import { SlaReportDto } from '../dto/sla-report.dto.js';
import { SlaReportService } from '../services/sla-report.service.js';

/**
 * ST-54.2 (RF-A07) — SLA compliance report.
 *
 * Error dictionary: VALIDATION_FAILED 400 (missing or invalid `from`, `to` or `groupBy`) | INVALID_DATE_RANGE 400 (`from` after `to`) |
 * DATE_RANGE_TOO_LARGE 400 (more than 366 days) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('SLA report')
@ApiBearerAuth('access-token')
@Controller('reports/sla')
export class SlaReportController {
    constructor(private readonly report: SlaReportService) {}

    @Get()
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'SLA compliance report grouped by zone, service level or driver',
        description: "Counts the delivery dispatches closed between `from` and `to` (YYYY-MM-DD, both inclusive, Bolivia days, matched against the closing time; at most 366 days) and groups them by `groupBy`: delivery zone (`zone`), service level (`service_level`, only the levels that are active) or driver of the route (`driver`). Cancelled dispatches are not counted. Per group (`rows`) and for all of them together (`totals`, built from the real sums, not from the averages): dispatches closed, delivered, delivered inside the committed window (`scheduled_window_start/end`) and after its end, the percentage delivered on time (over the delivered ones), the average delay in minutes of the late ones, the average cycle in minutes from the last departure of the route (`out_for_delivery`) to the delivery, and the number of incidents. A group without zone, level or driver comes with `groupId` and `groupName` null. The window is the one in force when the dispatch was delivered: a rescheduled dispatch is measured against its new window. The answer is cached in Redis for 10 minutes under a key made of the parameters, and nothing invalidates it, so a delivery just confirmed may take up to 10 minutes to show; if Redis does not answer it is computed from PostgreSQL. The CSV/Excel export is made by the client. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: SlaReportDto })
    @ApiBadRequests({
        validation: true,
        errors: [
            { code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." },
            { code: 'DATE_RANGE_TOO_LARGE', message: 'The date range must not exceed 366 days.' },
        ],
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'groupBy' parameter must be one of: zone, service_level, driver."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getReport(@Query() params: SlaReportParamsDto): Promise<SlaReportDto> {
        return await this.report.aggregate(params.from, params.to, params.groupBy);
    }
}
