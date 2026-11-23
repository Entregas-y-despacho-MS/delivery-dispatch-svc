import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { CoordinatorOnly } from '../../auth/decorators/index.js';
import { CutoffCoverageParamsDto, OperatingDateParamsDto, SnapshotFiltersDto } from '../dto/planning-snapshots-params.dto.js';
import { CutoffCoverageResponseDto, CutoffListResponseDto, RouteCompletionResponseDto } from '../dto/planning-snapshots.dto.js';
import { PlanningSnapshotsService } from '../services/planning-snapshots.service.js';

/**
 * ST-302.2 (ES-302, Dashboard 2: planning and execution of routes) — coverage at the cutoff and completion of the stops
 * of a started route, over the frozen universe and manifests.
 *
 * Error dictionary: VALIDATION_FAILED 400 (invalid `date`, `cutoffId`, `zoneId`, `warehouseId` or `shift`) |
 * INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Planning snapshots')
@ApiBearerAuth('access-token')
@Controller('planning')
export class PlanningSnapshotsController {
    constructor(private readonly service: PlanningSnapshotsService) {}

    @Get('cutoffs')
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Cutoffs of an operating day that left a planning snapshot',
        description:
            "Lists the runs of the D-1 cutoff that saved a snapshot for the routes of `date` (YYYY-MM-DD, America/La_Paz, default today), oldest first, each with how many dispatches were eligible and how many were excluded. `official` marks the first scheduled one: the cutoff whose universe is the denominator of the coverage; manual runs and later scheduled ones are listed but never replace it. A day with no snapshot returns an empty list: history before ST-302.2 is unknown and is not rebuilt from current statuses. Read-only. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: CutoffListResponseDto })
    @ApiBadRequests({ validation: true, example: ["The 'date' parameter must be a valid date in YYYY-MM-DD format."] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async listCutoffs(@Query() params: OperatingDateParamsDto): Promise<CutoffListResponseDto> {
        return await this.service.listCutoffs(params);
    }

    @Get('cutoffs/coverage')
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Coverage at the cutoff: confirmed over the dispatches eligible in the same cutoff',
        description:
            "Takes the official cutoff of `date` (the first scheduled one) or the cutoff `cutoffId`, and returns `confirmed / eligible` where `eligible` are the dispatches the cutoff itself found eligible, and `confirmed` those among them confirmed at the second approval after the cutoff. The denominator is frozen: the same cutoff gives the same `eligible` even if the routes advance, change batch or are replanned. Every exclusion comes with its `code` and an `explanation`, grouped in `byCode` and listed one by one with a `detailPath` to resolve it. `confirmedOutsideUniverse` counts dispatches confirmed that day that the cutoff did not have; they never enter the numerator. Without a snapshot it answers `available: false` with a `reason` (`NO_SNAPSHOT`, or `NO_OFFICIAL_SNAPSHOT` when only manual runs exist): the coverage is not available and is never rebuilt from current statuses. Filters: operating date, zone, origin warehouse and shift, applied to the zone, warehouse and promise window the dispatch had at the cutoff; the batch is never a filter. Read-only. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: CutoffCoverageResponseDto })
    @ApiBadRequests({
        validation: true,
        example: ["The 'date' parameter must be a valid date in YYYY-MM-DD format.", "The 'shift' parameter must be one of: morning, afternoon."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getCoverage(@Query() params: CutoffCoverageParamsDto): Promise<CutoffCoverageResponseDto> {
        return await this.service.getCoverage(params);
    }

    @Get('route-completion')
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Completion of the stops of the routes started on an operating day, over the frozen manifest',
        description:
            "For each route of `date` that has a `started` manifest (frozen when the route left), returns its stops by result: `delivered`, `pickupCompleted`, `unsuccessful`, `pending`, `excludedAtStart` (held back when the route left), `cancelledBeforeStart` and `removedBeforeStart` (confirmed stops that never left). Each stop is in exactly one category and the categories are never added into one number. The baseline is the stops of the `started` manifest plus the ones of the first `confirmed` manifest that did not leave; it never changes while the route advances, so the denominator is the same at any hour, and a stop shows its result as soon as it has one, without waiting for the batch to close. `finalizedPct` is `finalized / departed` of that route; the one in `summary` is weighted by stops, not an average of percentages. Routes of the day that are running or closed but have no `started` manifest (history before ST-302.2) come in `unknownRouteBatchIds` and are not rebuilt. The batch is detail of each route, never the unit of the KPI. Filters: operating date, zone, origin warehouse and shift. Not paginated: one operating day. Read-only. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: RouteCompletionResponseDto })
    @ApiBadRequests({
        validation: true,
        example: ["The 'date' parameter must be a valid date in YYYY-MM-DD format.", "The 'shift' parameter must be one of: morning, afternoon."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getRouteCompletion(@Query() params: SnapshotFiltersDto): Promise<RouteCompletionResponseDto> {
        return await this.service.getRouteCompletion(params);
    }
}
