import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { CoordinatorOnly } from '../../auth/decorators/index.js';
import { DeliveryBacklogDto } from '../dto/delivery-backlog.dto.js';
import { DeliveryBacklogParamsDto, OtdReportParamsDto } from '../dto/delivery-promise-params.dto.js';
import { OtdReportDto } from '../dto/otd-report.dto.js';
import { DeliveryBacklogService } from '../services/delivery-backlog.service.js';
import { OtdReportService } from '../services/otd-report.service.js';

const RANGE_ERRORS = [
    { code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." },
    { code: 'DATE_RANGE_TOO_LARGE', message: 'The date range must not exceed 366 days.' },
];

/**
 * ST-301.1 (ES-301, Dashboard 1: operational summary and service level) — OTD by cohort of expired promise and the volume
 * of the backlog by dispatch. The punctuality of ES-54 (`GET /reports/sla`) is not changed: `basis=deliveredAt` answers
 * that other rate from here, labelled as such.
 *
 * Error dictionary: VALIDATION_FAILED 400 (missing or invalid `from`, `to`, `zoneId`, `serviceLevelId`, `status`, `basis` (OTD) or `overdueLimit` (backlog)) |
 * INVALID_DATE_RANGE 400 (`from` after `to`) | DATE_RANGE_TOO_LARGE 400 (more than 366 days) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Delivery promise')
@ApiBearerAuth('access-token')
@Controller('reports/otd')
export class DeliveryPromiseController {
    constructor(
        private readonly otd: OtdReportService,
        private readonly backlog: DeliveryBacklogService,
    ) {}

    @Get()
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'On-time delivery (OTD) by cohort of expired promise, or the historic punctuality of completed deliveries',
        description:
            "With `basis=promise` (default) the universe is the delivery dispatches whose promise (the end of the committed window in force) expired between `from` and `to` (YYYY-MM-DD, both inclusive, Bolivia days) and before the moment of the query: open, failed, returned and late ones are in the denominator as not on time. The numerator is the dispatches delivered inside their window. A dispatch with a missing window, or one ending before it starts, is counted apart in `invalidWindowCount` and is not turned into 0. A cancelled dispatch is left out (`excludedCancellations`, with its reason) only if it was cancelled on or before the end of the promise in force at that moment, rebuilt from the reschedule history; a cancellation with no window to tell is counted in `unreconstructableCancellationCount` and the rate is then not reliable. A rescheduled dispatch is measured against the window in force (the last one accepted); `rescheduledPromiseCount` says how many. With `basis=deliveredAt` the answer is the historic punctuality of the completed deliveries by closing time (the ES-54 indicator, which `GET /reports/sla` keeps serving unchanged): the denominator is the delivered dispatches closed inside the range, and cancellations are only counted. Every answer carries the numerator, denominator, sample size `n`, the date basis and the time zone with the rate. `percentage` is null (\"Sin datos\") when the denominator is 0. `firstAttempt` is the delivery at the first attempt, rebuilt from the status events (an attempt is a trip that ends in a result; a `not_delivered` and the incident that caused it count once): delivered at the first attempt (on time or late, shown apart) over the dispatches whose first attempt already happened and could be rebuilt. Dispatches still waiting for their first chance and those whose history cannot be rebuilt are counted apart, out of the rate. It only covers the instrumented period: if `from` is earlier than `firstAttempt.coverage.from`, `available` is false and `percentage` is null (N/D), with the counts still shown. It places dispatches by the end of their promise window (else closing, else creation), the same for both `basis` values. Optional filters: zone, service level and current status. Not cached. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: OtdReportDto })
    @ApiBadRequests({
        validation: true,
        errors: RANGE_ERRORS,
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'basis' parameter must be one of: promise, deliveredAt."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getOtd(@Query() params: OtdReportParamsDto): Promise<OtdReportDto> {
        return await this.otd.getOtd(params, params.basis);
    }

    @Get('backlog')
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Operational summary: volume of the backlog by dispatch and list of open overdue dispatches',
        description:
            "Counts the delivery dispatches whose promise date falls between `from` and `to` (YYYY-MM-DD, both inclusive, Bolivia days; the end of the committed window, or the closing/creation time for a dispatch without a window; a cancelled dispatch is placed by its current window, while `/reports/otd` places it by the promise it had when it was cancelled, so the totals of one period of both endpoints can differ) in mutually exclusive buckets, each dispatch once by its own `dispatchId` and status (never by the status of its batch: one delivered inside a batch still in execution already counts as delivered): `delivered`, `openOverdue` (active with its promise expired), `pending` (active, promise not expired or without a valid window), `notDelivered`, `rescheduled`, `cancelled` and `returned` (`returned` and `returned_to_warehouse`). `pendingByStage` splits the pending ones by exclusive stage (the current status) and by how long they have been in it; `openOverdueByAge` does the same for the overdue ones. `backlogTotal` is `openOverdue` + `pending`: terminal buckets are never added to it. `openOverdue` lists the most overdue dispatches first, with the minutes overdue, the next action, the valid delivery attempts already used (`attemptsUsed`, null if they cannot be rebuilt) and how the first attempt went (`firstAttemptResult`), up to `overdueLimit`. Optional filters: zone, service level and current status. `empty` is true when nothing matches (\"Sin datos\"). Not cached. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: DeliveryBacklogDto })
    @ApiBadRequests({
        validation: true,
        errors: RANGE_ERRORS,
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'overdueLimit' parameter must be <= 100."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getBacklog(@Query() params: DeliveryBacklogParamsDto): Promise<DeliveryBacklogDto> {
        return await this.backlog.getBacklog(params, params.overdueLimit);
    }
}
