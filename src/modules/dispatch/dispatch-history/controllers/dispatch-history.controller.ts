import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DispatchHistoryService } from '../services/dispatch-history.service.js';
import { FindDispatchHistoryParamsDto } from '../dto/find-dispatch-history-params.dto.js';
import { FindDispatchHistoryResponseDto } from '../dto/dispatch-history.dto.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';

/**
 * ST-55.2 (RF-A08) — history of dispatches that are already finished.
 *
 * Error dictionary: VALIDATION_FAILED 400 (invalid filter, sort or page) | INVALID_DATE_RANGE 400 (`from` after `to`) |
 * INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Dispatch history')
@ApiBearerAuth('access-token')
@Controller('dispatches/history')
export class DispatchHistoryController {
    constructor(private readonly history: DispatchHistoryService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Search the history of finished dispatches',
        description: "Lists the dispatches in a final status (`delivered`, `not_delivered`, `returned`, `returned_to_warehouse`, `cancelled`) with filters that combine: `from` and `to` (YYYY-MM-DD, both inclusive, Bolivia days, matched against the closing time), `driverId`, `plate` (text contained in the plate of the vehicle of the route), `status` (final status) and `search` (text contained in the tracking code). Sort with `sortBy` (closedAt, trackingCode, recipient, driver, plate, status; default closedAt) and `order` (default desc, most recent first). The answer is `{ data, total, page, limit }` (10 per page by default, up to 100). Each row carries the driver and vehicle of its route, the departure time (when the route left, if recorded), the delivery time (only for `delivered`) and the closing time; a dispatch without a route has empty driver and vehicle. A `not_delivered` dispatch that is rescheduled leaves the history until it ends again. Requires coordinator or supervisor role, or root.",
    })
    @ApiOkResponse({ type: FindDispatchHistoryResponseDto })
    @ApiBadRequests({
        validation: true,
        errors: [{ code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." }],
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'limit' parameter must be <= 100."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findAll(@Query() params: FindDispatchHistoryParamsDto): Promise<FindDispatchHistoryResponseDto> {
        return await this.history.findAll(params);
    }
}
