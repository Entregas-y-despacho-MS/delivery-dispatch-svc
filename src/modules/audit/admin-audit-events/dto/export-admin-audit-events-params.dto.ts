import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';
import { AUDIT_EXPORT_FORMATS, AUDIT_EXPORT_MAX_ROWS, type AuditExportFormat } from '../domain/admin-audit-query.js';
import { FindAdminAuditEventsParamsDto } from './find-admin-audit-events-params.dto.js';

/**
 * The same filters, window and order as the search, plus the file format. `page` and `limit` are accepted so the screen
 * can send the query it already has, and are ignored: the export holds every row of the filtered result.
 */
export class ExportAdminAuditEventsParamsDto extends FindAdminAuditEventsParamsDto {
    @ApiProperty({
        enum: AUDIT_EXPORT_FORMATS,
        description: `File format. A CSV holds up to ${AUDIT_EXPORT_MAX_ROWS.csv} rows and a PDF up to ${AUDIT_EXPORT_MAX_ROWS.pdf}; a larger result is rejected with AUDIT_EXPORT_LIMIT_EXCEEDED and nothing is sent.`,
    })
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    @IsIn(AUDIT_EXPORT_FORMATS, { message: `The 'format' parameter must be one of: ${AUDIT_EXPORT_FORMATS.join(', ')}.` })
    format!: AuditExportFormat;
}
