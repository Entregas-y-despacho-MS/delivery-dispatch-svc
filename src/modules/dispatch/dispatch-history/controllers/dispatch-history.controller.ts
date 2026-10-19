import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { DispatchHistoryService } from '../services/dispatch-history.service.js';
import { ExportDispatchHistoryParamsDto, FindDispatchHistoryParamsDto } from '../dto/find-dispatch-history-params.dto.js';
import { FindDispatchHistoryResponseDto } from '../dto/dispatch-history.dto.js';
import { todayInOperatingTimeZone } from '../../dispatches/utils/operating-date.util.js';
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

    // Declared in the same controller as the listing; `export` is a fixed segment, so it never competes with an `:id`.
    @Get('export')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Export the history of finished dispatches as CSV',
        description: "Downloads, as a CSV file, every dispatch that matches the same filters and sort as `GET /dispatches/history` (`from`, `to`, `driverId`, `plate`, `status`, `search`, `sortBy`, `order`), without pagination: `page` and `limit` are accepted so the screen can send the query it already has, and are ignored. The file is UTF-8 with a byte-order mark (so Excel reads the accents), comma-separated, with CRLF line ends and one header row: `Código de traslado`, `Cliente`, `Repartidor`, `Vehículo`, `Hora de partida`, `Hora de entrega`, `Estado`. Times are `YYYY-MM-DD HH:mm:ss` in Bolivia time (e.g. `2026-10-10 11:30:00`; spreadsheets read them as dates); `Hora de entrega` is empty unless the status is `delivered`; `Estado` is the text the user sees (Entregado, No entregado, Devuelto, Devuelto a almacén, Cancelado), not the status code. A cell that starts with `=`, `+`, `-` or `@` is prefixed with a quote so a spreadsheet never runs it as a formula. The rows are streamed as they are read, so a large history does not load in memory. Invalid filters answer 400 before anything is sent. Requires coordinator or supervisor role, or root.",
    })
    @ApiProduces('text/csv')
    @ApiOkResponse({
        description: 'The CSV file (`Content-Disposition: attachment; filename="historial-despachos-YYYY-MM-DD.csv"`).',
        content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
    })
    @ApiBadRequests({
        validation: true,
        errors: [{ code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." }],
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'status' parameter must be one of: delivered, not_delivered, returned, returned_to_warehouse, cancelled."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    exportCsv(@Query() params: ExportDispatchHistoryParamsDto): StreamableFile {
        return new StreamableFile(this.history.exportCsv(params), {
            type: 'text/csv; charset=utf-8',
            disposition: `attachment; filename="historial-despachos-${todayInOperatingTimeZone()}.csv"`,
        });
    }
}
