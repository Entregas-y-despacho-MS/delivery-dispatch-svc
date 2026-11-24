import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../../../app/auth/decorators/roles.decorator.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { AUDIT_ACTION_KEY } from '../decorators/audit-action.decorator.js';
import type { ExportAdminAuditEventsParamsDto } from '../dto/export-admin-audit-events-params.dto.js';
import type { FindAdminAuditEventsParamsDto } from '../dto/find-admin-audit-events-params.dto.js';
import { AdminAuditEventsController } from './admin-audit-events.controller.js';

describe('AdminAuditEventsController', () => {
    it('passes the filters and the caller role to the query service and returns its page', async () => {
        const page = { data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } };
        const queryService = { find: vi.fn(async () => page) };
        const controller = new AdminAuditEventsController(queryService as never, {} as never);
        const params = { from: 'a', to: 'b' } as FindAdminAuditEventsParamsDto;
        await expect(controller.find(params, RoleEnum.ADMIN)).resolves.toBe(page);
        expect(queryService.find).toHaveBeenCalledWith(params, RoleEnum.ADMIN);
    });

    it('is reserved to the administrator (root bypasses through the guard)', () => {
        expect(Reflect.getMetadata(ROLES_KEY, AdminAuditEventsController.prototype.find)).toEqual([RoleEnum.ADMIN]);
    });

    describe('exportEvents', () => {
        const file = { body: Buffer.from('x'), contentType: 'text/csv; charset=utf-8', fileName: 'auditoria-admin-2026-11-24.csv' };

        it('passes the params and the caller role to the export service and sends the file as an attachment', async () => {
            const exportService = { export: vi.fn(async () => file) };
            const controller = new AdminAuditEventsController({} as never, exportService as never);
            const params = { from: 'a', to: 'b', format: 'csv' } as ExportAdminAuditEventsParamsDto;
            const response = await controller.exportEvents(params, RoleEnum.ADMIN);
            expect(exportService.export).toHaveBeenCalledWith(params, RoleEnum.ADMIN);
            expect(response.getHeaders()).toMatchObject({ type: 'text/csv; charset=utf-8', disposition: 'attachment; filename="auditoria-admin-2026-11-24.csv"' });
        });

        it('is reserved to the administrator and is an audited action that records the format and the filters', () => {
            expect(Reflect.getMetadata(ROLES_KEY, AdminAuditEventsController.prototype.exportEvents)).toEqual([RoleEnum.ADMIN]);
            const declared = Reflect.getMetadata(AUDIT_ACTION_KEY, AdminAuditEventsController.prototype.exportEvents);
            expect(declared).toMatchObject({ action: 'audit.exported', entityIdParam: null });
            expect(declared.queryFields).toEqual(expect.arrayContaining(['format', 'from', 'to', 'action', 'entityType', 'entityId', 'result', 'order']));
        });

        it('does not let a failed export reach the client as a file', async () => {
            const exportService = { export: vi.fn(async () => { throw new Error('too large'); }) };
            const controller = new AdminAuditEventsController({} as never, exportService as never);
            await expect(controller.exportEvents({} as never, RoleEnum.ADMIN)).rejects.toThrow('too large');
        });
    });
});
