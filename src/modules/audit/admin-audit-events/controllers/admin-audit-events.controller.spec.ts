import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../../../app/auth/decorators/roles.decorator.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import type { FindAdminAuditEventsParamsDto } from '../dto/find-admin-audit-events-params.dto.js';
import { AdminAuditEventsController } from './admin-audit-events.controller.js';

describe('AdminAuditEventsController', () => {
    it('passes the filters and the caller role to the query service and returns its page', async () => {
        const page = { data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } };
        const queryService = { find: vi.fn(async () => page) };
        const controller = new AdminAuditEventsController(queryService as never);
        const params = { from: 'a', to: 'b' } as FindAdminAuditEventsParamsDto;
        await expect(controller.find(params, RoleEnum.ADMIN)).resolves.toBe(page);
        expect(queryService.find).toHaveBeenCalledWith(params, RoleEnum.ADMIN);
    });

    it('is reserved to the administrator (root bypasses through the guard)', () => {
        expect(Reflect.getMetadata(ROLES_KEY, AdminAuditEventsController.prototype.find)).toEqual([RoleEnum.ADMIN]);
    });
});
