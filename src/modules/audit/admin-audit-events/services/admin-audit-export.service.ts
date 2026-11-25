import { Injectable } from '@nestjs/common';
import type { RoleEnum } from '../../../../shared/enums/index.js';
import { PdfPort } from '../../../../plugins/pdf/pdf.port.js';
import { todayInOperatingTimeZone } from '../../../dispatch/dispatches/utils/operating-date.util.js';
import { buildAuditCsv, buildAuditPdfHtml, type AuditExportContext } from '../domain/admin-audit-export.js';
import type { AuditExportFormat } from '../domain/admin-audit-query.js';
import type { ExportAdminAuditEventsParamsDto } from '../dto/export-admin-audit-events-params.dto.js';
import { AdminAuditQueryService } from './admin-audit-query.service.js';

/** A file ready to be sent: its bytes, media type and name. */
export interface AuditExportFile {
    body: Buffer;
    contentType: string;
    fileName: string;
}

const CONTENT_TYPE: Record<AuditExportFormat, string> = { csv: 'text/csv; charset=utf-8', pdf: 'application/pdf' };

/**
 * Export of the audit search (RF-A38). The rows come from `AdminAuditQueryService.findForExport`, the same query, order
 * and role projection as the search, so the file never holds a row, an order or a detail the screen would not show.
 * Everything is validated and read before a file is built: a rejected request never produces one.
 */
@Injectable()
export class AdminAuditExportService {
    constructor(
        private readonly query: AdminAuditQueryService,
        private readonly pdf: PdfPort,
    ) {}

    async export(params: ExportAdminAuditEventsParamsDto, role: RoleEnum, now: Date = new Date()): Promise<AuditExportFile> {
        const { range, events } = await this.query.findForExport(params, params.format, role);
        const context: AuditExportContext = {
            from: range.from,
            to: range.to,
            generatedAt: now,
            role,
            filters: {
                actorId: params.actorId,
                actorRole: params.actorRole,
                action: params.action,
                entityType: params.entityType,
                entityId: params.entityId,
                result: params.result,
                correlationId: params.correlationId,
                order: params.order,
            },
        };

        const body = params.format === 'csv'
            ? Buffer.from(buildAuditCsv(context, events), 'utf8')
            : await this.pdf.generate(buildAuditPdfHtml(context, events), { format: 'A4', landscape: true, margin: { top: '12mm', bottom: '12mm', left: '8mm', right: '8mm' } });

        return { body, contentType: CONTENT_TYPE[params.format], fileName: `auditoria-admin-${todayInOperatingTimeZone(now)}.${params.format}` };
    }
}
