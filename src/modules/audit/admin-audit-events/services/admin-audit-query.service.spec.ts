import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { InvalidAuditFilterException, InvalidAuditRangeException } from '../exceptions/invalid-audit-query.exception.js';
import type { AdminAuditEventEntity } from '../entities/admin-audit-event.entity.js';
import type { FindAdminAuditEventsParamsDto } from '../dto/find-admin-audit-events-params.dto.js';
import { AUDIT_EXPORT_MAX_ROWS } from '../domain/admin-audit-query.js';
import { AuditExportLimitExceededException } from '../exceptions/invalid-audit-query.exception.js';
import { AdminAuditQueryService } from './admin-audit-query.service.js';

const row = { id: 'e1', actorUserId: 4, actorRole: 'admin', action: 'user.created', entityType: 'user', entityId: '9', result: 'success', statusCode: 201, correlationId: 'req-123456', ipAddress: '10.0.0.7', metadata: { a: 1 }, occurredAt: new Date('2026-11-20T10:00:00Z') } as unknown as AdminAuditEventEntity;

function build(result: [AdminAuditEventEntity[], number] = [[row], 1]) {
    const query = {
        where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(),
        addOrderBy: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(),
        getManyAndCount: vi.fn(async () => result),
        getMany: vi.fn(async () => result[0]),
    };
    const repo = { createQueryBuilder: vi.fn(() => query) };
    return { query, service: new AdminAuditQueryService(repo as never) };
}

const params = (over: Partial<FindAdminAuditEventsParamsDto> = {}) =>
    ({ from: '2026-11-20T00:00:00-04:00', to: '2026-11-21T00:00:00-04:00', page: 1, limit: 10, order: 'desc', ...over }) as FindAdminAuditEventsParamsDto;

describe('AdminAuditQueryService.find', () => {
    it('filters by the half-open window only when no other filter is given', async () => {
        const { service, query } = build();
        await service.find(params(), RoleEnum.ADMIN);
        expect(query.where).toHaveBeenCalledWith('event.occurredAt >= :from AND event.occurredAt < :to', { from: new Date('2026-11-20T04:00:00Z'), to: new Date('2026-11-21T04:00:00Z') });
        expect(query.andWhere).not.toHaveBeenCalled();
    });

    it('combines every filter with AND, parametrized', async () => {
        const { service, query } = build();
        await service.find(params({ actorId: 4, actorRole: 'admin' as never, action: 'user.created', entityType: 'user', entityId: '9', result: 'success', correlationId: 'req-123456' }), RoleEnum.ADMIN);
        expect(query.andWhere.mock.calls).toEqual([
            ['event.actorUserId = :actorId', { actorId: 4 }],
            ['event.actorRole = :actorRole', { actorRole: 'admin' }],
            ['event.action = :action', { action: 'user.created' }],
            ['event.entityType = :entityType', { entityType: 'user' }],
            ['event.entityId = :entityId', { entityId: '9' }],
            ['event.result = :result', { result: 'success' }],
            ['event.correlationId = :correlationId', { correlationId: 'req-123456' }],
        ]);
    });

    it.each([['desc', 'DESC'], ['asc', 'ASC']] as const)('orders by time and then by id in the same direction (%s)', async (order, direction) => {
        const { service, query } = build();
        await service.find(params({ order }), RoleEnum.ADMIN);
        expect(query.orderBy).toHaveBeenCalledWith('event.occurredAt', direction);
        expect(query.addOrderBy).toHaveBeenCalledWith('event.id', direction);
    });

    it('paginates with skip and take and reports the metadata', async () => {
        const { service, query } = build([[row], 45]);
        const page = await service.find(params({ page: 3, limit: 20 }), RoleEnum.ADMIN);
        expect(query.skip).toHaveBeenCalledWith(40);
        expect(query.take).toHaveBeenCalledWith(20);
        expect(page.meta).toEqual({ page: 3, limit: 20, total: 45, pages: 3 });
    });

    it('answers an empty page, not an error, when nothing matches', async () => {
        const { service } = build([[], 0]);
        await expect(service.find(params(), RoleEnum.ADMIN)).resolves.toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
    });

    it('projects the events by role', async () => {
        const { service } = build();
        expect((await service.find(params(), RoleEnum.ADMIN)).data[0]).not.toHaveProperty('ip');
        expect((await service.find(params(), RoleEnum.ROOT)).data[0]).toMatchObject({ ip: '10.0.0.7', metadata: { a: 1 } });
    });

    it('rejects a bad window or an entity id without type before touching the database', async () => {
        const { service, query } = build();
        await expect(service.find(params({ to: '2026-11-19T00:00:00-04:00' }), RoleEnum.ADMIN)).rejects.toBeInstanceOf(InvalidAuditRangeException);
        await expect(service.find(params({ entityId: '9' }), RoleEnum.ADMIN)).rejects.toBeInstanceOf(InvalidAuditFilterException);
        expect(query.getManyAndCount).not.toHaveBeenCalled();
    });
});

describe('AdminAuditQueryService.findForExport', () => {
    it('builds the same query as the search: same window, filters and order', async () => {
        const filters = { actorId: 4, action: 'user.created', entityType: 'user', entityId: '9', result: 'success' as const, order: 'asc' as const };
        const search = build();
        await search.service.find(params(filters), RoleEnum.ADMIN);
        const exported = build();
        await exported.service.findForExport(params(filters), 'csv', RoleEnum.ADMIN);
        expect(exported.query.where.mock.calls).toEqual(search.query.where.mock.calls);
        expect(exported.query.andWhere.mock.calls).toEqual(search.query.andWhere.mock.calls);
        expect(exported.query.orderBy.mock.calls).toEqual(search.query.orderBy.mock.calls);
        expect(exported.query.addOrderBy.mock.calls).toEqual(search.query.addOrderBy.mock.calls);
    });

    it('ignores page and limit: it is never paginated', async () => {
        const { service, query } = build();
        await service.findForExport(params({ page: 3, limit: 5 }), 'csv', RoleEnum.ADMIN);
        expect(query.skip).not.toHaveBeenCalled();
        expect(query.take).toHaveBeenCalledWith(AUDIT_EXPORT_MAX_ROWS.csv + 1);
    });

    it.each([['csv'], ['pdf']] as const)('reads one row more than the %s maximum to detect an oversized result', async (format) => {
        const { service, query } = build();
        await service.findForExport(params(), format, RoleEnum.ADMIN);
        expect(query.take).toHaveBeenCalledWith(AUDIT_EXPORT_MAX_ROWS[format] + 1);
    });

    it('accepts a result of exactly the maximum and rejects one row more, without returning any data', async () => {
        const rows = (n: number) => Array.from({ length: n }, () => row);
        const exact = build([rows(AUDIT_EXPORT_MAX_ROWS.pdf), 0]);
        await expect(exact.service.findForExport(params(), 'pdf', RoleEnum.ADMIN)).resolves.toMatchObject({ events: expect.any(Array) });
        const over = build([rows(AUDIT_EXPORT_MAX_ROWS.pdf + 1), 0]);
        await expect(over.service.findForExport(params(), 'pdf', RoleEnum.ADMIN)).rejects.toBeInstanceOf(AuditExportLimitExceededException);
    });

    it('answers an empty export, not an error, when nothing matches', async () => {
        const { service } = build([[], 0]);
        await expect(service.findForExport(params(), 'csv', RoleEnum.ADMIN)).resolves.toMatchObject({ events: [] });
    });

    it('projects the events by role: only root gets the address and the declared fields', async () => {
        const { service } = build();
        expect((await service.findForExport(params(), 'csv', RoleEnum.ADMIN)).events[0]).not.toHaveProperty('ip');
        expect((await service.findForExport(params(), 'csv', RoleEnum.ROOT)).events[0]).toMatchObject({ ip: '10.0.0.7', metadata: { a: 1 } });
    });

    it('rejects a bad window or an entity id without type before touching the database', async () => {
        const { service, query } = build();
        await expect(service.findForExport(params({ to: '2026-11-19T00:00:00-04:00' }), 'csv', RoleEnum.ADMIN)).rejects.toBeInstanceOf(InvalidAuditRangeException);
        await expect(service.findForExport(params({ entityId: '9' }), 'csv', RoleEnum.ADMIN)).rejects.toBeInstanceOf(InvalidAuditFilterException);
        expect(query.getMany).not.toHaveBeenCalled();
    });
});
