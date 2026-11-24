import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { AdminOnly } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';
import { AuditAction } from '../decorators/audit-action.decorator.js';
import { ExportAdminAuditEventsParamsDto } from '../dto/export-admin-audit-events-params.dto.js';
import { FindAdminAuditEventsParamsDto } from '../dto/find-admin-audit-events-params.dto.js';
import { FindAdminAuditEventsResponseDto } from '../dto/admin-audit-event.dto.js';
import { AdminAuditExportService } from '../services/admin-audit-export.service.js';
import { AdminAuditQueryService } from '../services/admin-audit-query.service.js';

/**
 * Error dictionary: INVALID_AUDIT_RANGE 400, INVALID_AUDIT_FILTER 400, AUDIT_EXPORT_LIMIT_EXCEEDED 400, VALIDATION_FAILED 400,
 *   INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403, PDF_GENERATION_FAILED 500
 */
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Controller('audit/admin-events')
export class AdminAuditEventsController {
    constructor(
        private readonly queryService: AdminAuditQueryService,
        private readonly exportService: AdminAuditExportService,
    ) {}

    @Get()
    @AdminOnly()
    @ApiOperation({
        summary: 'Search the administrative audit trail',
        description:
            "Returns a page of audited administrative actions (RF-A37) inside the window [from, to): 'from' is included, 'to' is not, and both carry an explicit offset (a '+' in the query string must be sent as %2B). The window must not exceed 31 days. Filters combine with AND. Ordered by event time and then by event id in the same direction ('order', default desc), so pages never repeat or skip rows. A window without events answers 200 with an empty list. The client address and the declared body fields are returned only to root. Requires administrator role, or root; coordinators, supervisors and drivers receive 403.",
    })
    @ApiBadRequests({
        validation: true,
        example: ["The 'limit' parameter must be <= 100.", "The 'from' parameter must be an ISO 8601 date-time with an explicit offset (e.g. 2026-11-20T00:00:00-04:00)."],
        errors: [
            { code: 'INVALID_AUDIT_RANGE', message: "The 'from' parameter must be before 'to'." },
            { code: 'INVALID_AUDIT_RANGE', message: "The range between 'from' and 'to' must not exceed 31 days." },
            { code: 'INVALID_AUDIT_FILTER', message: "The 'entityId' parameter requires 'entityType'." },
        ],
    })
    @ApiOkResponse({ type: FindAdminAuditEventsResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async find(
        @Query() params: FindAdminAuditEventsParamsDto,
        @CurrentUser('role') role: RoleEnum,
    ): Promise<FindAdminAuditEventsResponseDto> {
        return await this.queryService.find(params, role);
    }

    // Declared in the same controller as the search; `export` is a fixed segment, so it never competes with an `:id`.
    @Get('export')
    @AdminOnly()
    @AuditAction('audit.exported', {
        entityIdParam: null,
        queryFields: ['format', 'from', 'to', 'actorId', 'actorRole', 'action', 'entityType', 'entityId', 'result', 'correlationId', 'order'],
    })
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Export the administrative audit trail as CSV or PDF',
        description:
            "Downloads exactly what 'GET /audit/admin-events' lists for the same 'from'/'to' window and filters (RF-A38): the same events, in the same order and with the same detail for the caller's role (the client address and the declared body fields only for root), without pagination ('page' and 'limit' are accepted and ignored). 'format' is 'csv' or 'pdf'. Everything is validated before a file is built: an invalid format, window or filter, or a result larger than the maximum (10000 rows for CSV, 2000 for PDF; AUDIT_EXPORT_LIMIT_EXCEEDED, narrow the window or add filters), answers 400 and no file is sent. A window without events is a valid, empty file. The CSV is UTF-8 with a byte-order mark, comma-separated, CRLF line ends: a header block (period with its borders, time zone, applied filters, generation time and row count), a blank line, the column headers and one row per event; a cell that starts with '=', '+', '-', '@', a tab or a carriage return is prefixed with a quote so a spreadsheet never runs it as a formula. The PDF (A4, landscape) carries the same header block and the same columns. Times are 'YYYY-MM-DD HH:mm:ss' in Bolivia time. Every export is itself audited ('audit.exported', with the format and the filters). Requires administrator role, or root; coordinators, supervisors and drivers receive 403 and no file.",
    })
    @ApiProduces('text/csv', 'application/pdf')
    @ApiOkResponse({
        description: 'The file (`Content-Disposition: attachment; filename="auditoria-admin-YYYY-MM-DD.csv"` or `.pdf`).',
        content: {
            'text/csv': { schema: { type: 'string', format: 'binary' } },
            'application/pdf': { schema: { type: 'string', format: 'binary' } },
        },
    })
    @ApiBadRequests({
        validation: true,
        example: ["The 'format' parameter must be one of: csv, pdf.", "The 'from' parameter must be an ISO 8601 date-time with an explicit offset (e.g. 2026-11-20T00:00:00-04:00)."],
        errors: [
            { code: 'INVALID_AUDIT_RANGE', message: "The range between 'from' and 'to' must not exceed 31 days." },
            { code: 'INVALID_AUDIT_FILTER', message: "The 'entityId' parameter requires 'entityType'." },
            { code: 'AUDIT_EXPORT_LIMIT_EXCEEDED', message: "The export has more than 10000 rows, the maximum for CSV. Narrow the 'from'/'to' window or add filters and export again." },
        ],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async exportEvents(
        @Query() params: ExportAdminAuditEventsParamsDto,
        @CurrentUser('role') role: RoleEnum,
    ): Promise<StreamableFile> {
        const file = await this.exportService.export(params, role);
        return new StreamableFile(file.body, { type: file.contentType, disposition: `attachment; filename="${file.fileName}"` });
    }
}
