import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../shared/decorators/index.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { Roles } from '../../auth/decorators/index.js';
import type { AuthUser } from '../../auth/strategies/jwt.strategy.js';
import { assertSlaRange } from '../../sla-report/domain/sla-date-range.js';
import { QualityKpisParamsDto } from '../dto/quality-kpis-params.dto.js';
import { QualityKpisReportDto } from '../dto/quality-kpis-response.dto.js';
import { QualityKpisService } from '../services/quality-kpis.service.js';

/** Who may read the global rating of the customers (ST-300.2): the supervisor and root. The coordinator sees the rest and gets the rating as N/D. */
const RATING_ROLES: readonly string[] = [RoleEnum.ROOT, RoleEnum.SUPERVISOR];

/**
 * ST-300.2 (ES-300, Dashboard 4: quality, incidents and claims) — the quality indicators and their tables, read-only.
 *
 * Error dictionary: VALIDATION_FAILED 400 (missing or invalid `from`, `to`, `timeZone`, `zoneId`, `incidentReasonId`, `reasonCode`,
 * `status`, `rescheduled`, `order`, `page` or `limit`) | INVALID_DATE_RANGE 400 (`from` after `to`) | DATE_RANGE_TOO_LARGE 400 (more than 366 days) |
 * INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Quality KPIs')
@ApiBearerAuth('access-token')
@Controller('reports/quality')
export class QualityKpisController {
    constructor(private readonly quality: QualityKpisService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'Dashboard 4: quality of the delivery, incidents, reschedules, claims and customer experience',
        description:
            "Returns the indicators of the period with their formula, numerator, denominator, sample size `n` and date basis, the counts shown apart (`details`), the filters that were applied, the sources and two paginated tables kept apart: the complaint cases and the dispatches. `from` and `to` (YYYY-MM-DD, inclusive, Bolivia days, at most 366) place incidents and reschedules by the end of the promise window and claims and ratings by the closing of the delivery; days are read in America/La_Paz and calculated on UTC timestamps (`timeZone` only accepts that value). Incidents per 100 attempts counts attempts, not events: two incidents of the same attempt count once. A figure that cannot be told is N/D (`available: false`, with its `reason`) and the counts stay; a period with nothing to measure is «Sin datos» (`value: null`, `available: true`); a zero is never made up. Open claim cases are counted with their age and stay out of the median. The global rating is only calculated for the supervisor and root: for the coordinator it is N/D with `rating_not_authorized` and is not even read. The response rate is N/D until the invitation to rate is recorded. Filters combine: `zoneId`, `status`, `incidentReasonId` (numerator of the incident rate), `reasonCode` (the claim cases) and `rescheduled`. `page`/`limit`/`order` paginate both tables by id; the indicators always cover the whole filtered cohort. The tables carry no personal data and no evidence URL. Not cached. Requires coordinator or supervisor role, or root.",
    })
    @ApiOkResponse({ type: QualityKpisReportDto })
    @ApiBadRequests({
        validation: true,
        errors: [
            { code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." },
            { code: 'DATE_RANGE_TOO_LARGE', message: 'The date range must not exceed 366 days.' },
        ],
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'timeZone' parameter must be America/La_Paz."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getQuality(@Query() params: QualityKpisParamsDto, @CurrentUser() user: AuthUser): Promise<QualityKpisReportDto> {
        assertSlaRange(params.from, params.to);
        const { page, limit, order, timeZone: _timeZone, ...filters } = params;
        return await this.quality.getQualityKpis(filters, { ratingsAuthorized: RATING_ROLES.includes(user.role), page, limit, order });
    }
}
