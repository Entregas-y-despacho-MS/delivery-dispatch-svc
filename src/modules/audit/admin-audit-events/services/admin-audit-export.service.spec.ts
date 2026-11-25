import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { AuditExportLimitExceededException } from '../exceptions/invalid-audit-query.exception.js';
import type { AuditEventView } from '../domain/admin-audit-query.js';
import type { ExportAdminAuditEventsParamsDto } from '../dto/export-admin-audit-events-params.dto.js';
import { AdminAuditExportService } from './admin-audit-export.service.js';

const event = (id: string): AuditEventView => ({
    eventId: id, occurredAt: new Date('2026-11-20T14:30:00Z'), actorId: 4, actorRole: 'admin', action: 'user.created',
    entityType: 'user', entityId: '9', result: 'success', statusCode: 201, correlationId: 'req-123456',
});
const range = { from: new Date('2026-11-20T04:00:00Z'), to: new Date('2026-11-21T04:00:00Z') };
const now = new Date('2026-11-24T16:05:09Z');

const params = (over: Partial<ExportAdminAuditEventsParamsDto> = {}) =>
    ({ from: '2026-11-20T00:00:00-04:00', to: '2026-11-21T00:00:00-04:00', format: 'csv', order: 'desc', page: 1, limit: 10, ...over }) as ExportAdminAuditEventsParamsDto;

function build(events: AuditEventView[] = [event('id-b'), event('id-a')]) {
    const query = { findForExport: vi.fn(async (..._args: unknown[]) => ({ range, events })) };
    const pdf = { generate: vi.fn(async (..._args: unknown[]) => Buffer.from('%PDF-1.7')) };
    return { query, pdf, service: new AdminAuditExportService(query as never, pdf as never) };
}

describe('AdminAuditExportService.export', () => {
    it('asks the shared query for the rows of the requested format and role', async () => {
        const { service, query } = build();
        const p = params({ format: 'pdf' });
        await service.export(p, RoleEnum.ROOT, now);
        expect(query.findForExport).toHaveBeenCalledWith(p, 'pdf', RoleEnum.ROOT);
    });

    it('builds a CSV file with the rows in the order of the query, the filters and the generation time', async () => {
        const { service, pdf } = build();
        const file = await service.export(params({ action: 'user.created' }), RoleEnum.ADMIN, now);
        const text = file.body.toString('utf8');
        expect(file).toMatchObject({ contentType: 'text/csv; charset=utf-8', fileName: 'auditoria-admin-2026-11-24.csv' });
        expect(text.startsWith('﻿')).toBe(true);
        expect(text).toContain('Filtro: Acción,user.created');
        expect(text).toContain('Generado el,2026-11-24 12:05:09');
        expect(text.indexOf('id-b')).toBeLessThan(text.indexOf('id-a'));
        expect(pdf.generate).not.toHaveBeenCalled();
    });

    it('renders the PDF from the same rows, in landscape A4, and names it .pdf', async () => {
        const { service, pdf } = build();
        const file = await service.export(params({ format: 'pdf', result: 'failed' }), RoleEnum.ADMIN, now);
        expect(file).toMatchObject({ contentType: 'application/pdf', fileName: 'auditoria-admin-2026-11-24.pdf' });
        expect(file.body.toString()).toBe('%PDF-1.7');
        const [html, options] = pdf.generate.mock.calls[0] as [string, Record<string, unknown>];
        expect(html).toContain('Filtro: Resultado');
        expect(html.indexOf('id-b')).toBeLessThan(html.indexOf('id-a'));
        expect(options).toMatchObject({ format: 'A4', landscape: true });
    });

    it('names the file after the Bolivia day, not the UTC one', async () => {
        const { service } = build();
        const lateUtc = new Date('2026-11-25T02:00:00Z');
        expect((await service.export(params(), RoleEnum.ADMIN, lateUtc)).fileName).toBe('auditoria-admin-2026-11-24.csv');
    });

    it('builds nothing when the query rejects the request', async () => {
        const { service, query, pdf } = build();
        query.findForExport.mockRejectedValueOnce(new AuditExportLimitExceededException('pdf', 2000));
        await expect(service.export(params({ format: 'pdf' }), RoleEnum.ADMIN, now)).rejects.toBeInstanceOf(AuditExportLimitExceededException);
        expect(pdf.generate).not.toHaveBeenCalled();
    });

    it('lets a PDF engine failure propagate (no half file)', async () => {
        const { service, pdf } = build();
        pdf.generate.mockRejectedValueOnce(new Error('chrome crashed'));
        await expect(service.export(params({ format: 'pdf' }), RoleEnum.ADMIN, now)).rejects.toThrow('chrome crashed');
    });
});
