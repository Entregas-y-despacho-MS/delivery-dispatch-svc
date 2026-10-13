// ST-50.4 — RouteBatchReviewerService.assignReviewer: balance de carga del revisor (D-42). Todo mockeado.
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchReviewerService } from './route-batch-reviewer.service.js';
import { RouteBatchNotFoundException, RouteBatchNotProvisionalException, RouteBatchReviewerNotEligibleException } from '../exceptions/index.js';

// Reasignación automática: un escaneo (dataSource.query) y una transacción por lote.
function buildSweep(opts: { scan: number[]; locked?: Record<number, { reviewer_user_id: number | null; status: string; eligible: boolean }>; coordinators?: ({ id: number; pending: string } | null)[] }) {
    const batchRepo  = { update: vi.fn().mockResolvedValue(undefined) };
    const eventsRepo = { create: vi.fn((d: object) => d), save: vi.fn().mockResolvedValue(undefined) };
    const queue = [...(opts.coordinators ?? [])];
    const manager = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
            if (/FROM route_batches b\s+WHERE b\.route_batch_id/.test(sql)) {
                const row = (opts.locked ?? {})[params[0] as number] ?? { reviewer_user_id: 3, status: 'provisional', eligible: false };
                return [row];
            }
            if (/FROM users u/.test(sql)) { const next = queue.shift(); return next ? [next] : []; }
            return [];
        }),
        getRepository: vi.fn((e: { name: string }) => (e.name === 'RouteBatchEvent' ? eventsRepo : batchRepo)),
    };
    const dataSource = {
        query: vi.fn().mockResolvedValue(opts.scan.map((id) => ({ id }))),
        transaction: vi.fn(async (fn: (m: unknown) => unknown) => fn(manager)),
    };
    return { service: new RouteBatchReviewerService(dataSource as any), dataSource, manager, batchRepo, eventsRepo };
}

describe('RouteBatchReviewerService.reassignFromIneligibleReviewers', () => {
    it('reasigna el lote completo por balance y registra el evento del sistema con el revisor anterior', async () => {
        const { service, batchRepo, eventsRepo } = buildSweep({ scan: [10], coordinators: [{ id: 8, pending: '2' }] });

        const result = await service.reassignFromIneligibleReviewers('user_deactivated');

        expect(result).toEqual([{ routeBatchId: 10, reviewerUserId: 8, changed: true }]);
        expect(batchRepo.update).toHaveBeenCalledWith(10, { reviewerUserId: 8 });
        expect(eventsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            routeBatchId: 10, eventType: 'reviewer_reassigned', actorUserId: null, actorType: 'system',
            metadata: { from: 3, to: 8, pendingBatches: 2, mode: 'automatic', trigger: 'user_deactivated' },
        }));
    });

    it('el escaneo solo mira lotes provisional con revisor y exige coordinador/supervisor activo', async () => {
        const { service, dataSource } = buildSweep({ scan: [] });

        await service.reassignFromIneligibleReviewers();

        const [sql, params] = dataSource.query.mock.calls[0];
        expect(sql).toMatch(/b\.status = \$1 AND b\.reviewer_user_id IS NOT NULL/);
        expect(sql).toMatch(/ru\.active = TRUE AND ru\.deleted_at IS NULL/);
        expect(params).toEqual(['provisional', ['coordinator', 'supervisor']]);
    });

    it('sin coordinadores activos deja el lote sin revisor y registra reviewer_unassigned', async () => {
        const { service, batchRepo, eventsRepo } = buildSweep({ scan: [10], coordinators: [null] });

        const result = await service.reassignFromIneligibleReviewers();

        expect(result).toEqual([{ routeBatchId: 10, reviewerUserId: null, changed: true }]);
        expect(batchRepo.update).toHaveBeenCalledWith(10, { reviewerUserId: null });
        expect(eventsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'reviewer_unassigned', actorType: 'system',
            metadata: expect.objectContaining({ from: 3, reason: 'no_active_coordinators', mode: 'automatic' }),
        }));
    });

    it('varios lotes: cada uno en su transacción, así el balance ve el reparto anterior', async () => {
        const { service, dataSource, batchRepo } = buildSweep({
            scan: [10, 11],
            coordinators: [{ id: 8, pending: '0' }, { id: 9, pending: '0' }],
        });

        const result = await service.reassignFromIneligibleReviewers();

        expect(dataSource.transaction).toHaveBeenCalledTimes(2);
        expect(result.map((r) => r.reviewerUserId)).toEqual([8, 9]);
        expect(batchRepo.update).toHaveBeenNthCalledWith(1, 10, { reviewerUserId: 8 });
        expect(batchRepo.update).toHaveBeenNthCalledWith(2, 11, { reviewerUserId: 9 });
    });

    it('si entre el escaneo y el lock el lote ya se corrigió (revisor elegible, aprobado) no hace nada', async () => {
        const { service, batchRepo, eventsRepo } = buildSweep({
            scan: [10, 11],
            locked: {
                10: { reviewer_user_id: 5, status: 'provisional', eligible: true },
                11: { reviewer_user_id: 3, status: 'confirmed', eligible: false },
            },
            coordinators: [{ id: 8, pending: '0' }],
        });

        const result = await service.reassignFromIneligibleReviewers();

        expect(result).toEqual([]);
        expect(batchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).not.toHaveBeenCalled();
    });

    it('sin lotes con revisor inelegible no abre ninguna transacción', async () => {
        const { service, dataSource } = buildSweep({ scan: [] });

        expect(await service.reassignFromIneligibleReviewers()).toEqual([]);
        expect(dataSource.transaction).not.toHaveBeenCalled();
    });
});

function buildManual(opts: { batch?: { reviewer_user_id: number | null; status: string; version: number } | null; eligible?: boolean }) {
    const batch = opts.batch === undefined ? { reviewer_user_id: 3, status: 'provisional', version: 2 } : opts.batch;
    const batchRepo  = { update: vi.fn().mockResolvedValue(undefined) };
    const eventsRepo = { create: vi.fn((d: object) => d), save: vi.fn().mockResolvedValue(undefined) };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
        if (/FROM route_batches WHERE/.test(sql)) return batch ? [batch] : [];
        if (/FROM users u/.test(sql)) return opts.eligible === false ? [] : [{ '?column?': 1 }];
        return [];
    });
    const manager = {
        query,
        getRepository: vi.fn((e: { name: string }) => (e.name === 'RouteBatchEvent' ? eventsRepo : batchRepo)),
    };
    const dataSource = { transaction: vi.fn(async (fn: (m: unknown) => unknown) => fn(manager)) };
    return { service: new RouteBatchReviewerService(dataSource as any), manager, batchRepo, eventsRepo };
}

describe('RouteBatchReviewerService.reassignReviewer', () => {
    it('reasigna el lote completo, registra el evento con el usuario, el anterior y el motivo, y no toca la versión', async () => {
        const { service, batchRepo, eventsRepo } = buildManual({});

        const result = await service.reassignReviewer(10, 7, 99, 'Coordinator on leave.');

        expect(result).toEqual({ id: 10, status: 'provisional', reviewerUserId: 7, version: 2 });
        expect(batchRepo.update).toHaveBeenCalledWith(10, { reviewerUserId: 7 });
        expect(eventsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            routeBatchId: 10, eventType: 'reviewer_reassigned', actorUserId: 99, actorType: 'user',
            reason: 'Coordinator on leave.', metadata: { from: 3, to: 7, mode: 'manual' },
        }));
    });

    it('valida que el destino sea coordinador o supervisor activo y no borrado', async () => {
        const { service, manager } = buildManual({});

        await service.reassignReviewer(10, 7, 99);

        const call = manager.query.mock.calls.find(([sql]) => /FROM users u/.test(sql))!;
        expect(call[0]).toMatch(/u\.active = TRUE/);
        expect(call[0]).toMatch(/u\.deleted_at IS NULL/);
        expect(call[1]).toEqual([7, ['coordinator', 'supervisor']]);
    });

    it('destino inactivo, de otro rol o inexistente → 409 y no escribe', async () => {
        const { service, batchRepo, eventsRepo } = buildManual({ eligible: false });

        await expect(service.reassignReviewer(10, 7, 99)).rejects.toBeInstanceOf(RouteBatchReviewerNotEligibleException);
        expect(batchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).not.toHaveBeenCalled();
    });

    it('un lote sin revisor también se puede asignar a mano (from null)', async () => {
        const { service, eventsRepo } = buildManual({ batch: { reviewer_user_id: null, status: 'provisional', version: 0 } });

        await service.reassignReviewer(10, 7, 99);

        expect(eventsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ metadata: { from: null, to: 7, mode: 'manual' }, reason: null }));
    });

    it('con el mismo revisor responde igual y no escribe ni registra evento', async () => {
        const { service, batchRepo, eventsRepo } = buildManual({});

        const result = await service.reassignReviewer(10, 3, 99);

        expect(result.reviewerUserId).toBe(3);
        expect(batchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).not.toHaveBeenCalled();
    });

    it('lote inexistente → ROUTE_BATCH_NOT_FOUND', async () => {
        const { service } = buildManual({ batch: null });
        await expect(service.reassignReviewer(10, 7, 99)).rejects.toBeInstanceOf(RouteBatchNotFoundException);
    });

    it.each(['pending_final_review', 'confirmed', 'in_execution', 'closed', 'cancelled'])('lote %s → 409 y no escribe', async (status) => {
        const { service, batchRepo } = buildManual({ batch: { reviewer_user_id: 3, status, version: 1 } });

        await expect(service.reassignReviewer(10, 7, 99)).rejects.toBeInstanceOf(RouteBatchNotProvisionalException);
        expect(batchRepo.update).not.toHaveBeenCalled();
    });
});

function build(opts: { batch?: { reviewer_user_id: number | null; status: string } | null; coordinator?: { id: number; pending: string } | null }) {
    const batch = opts.batch === undefined ? { reviewer_user_id: null, status: 'provisional' } : opts.batch;
    const batchRepo  = { update: vi.fn().mockResolvedValue(undefined) };
    const eventsRepo = { create: vi.fn((d: object) => d), save: vi.fn().mockResolvedValue(undefined) };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
        if (/FROM route_batches WHERE/.test(sql)) return batch ? [batch] : [];
        if (/FROM users u/.test(sql)) return opts.coordinator ? [opts.coordinator] : [];
        return [];
    });
    const manager = {
        query,
        getRepository: vi.fn((e: { name: string }) => (e.name === 'RouteBatchEvent' ? eventsRepo : batchRepo)),
    };
    const dataSource = { transaction: vi.fn(async (fn: (m: unknown) => unknown) => fn(manager)) };
    return { service: new RouteBatchReviewerService(dataSource as any), manager, batchRepo, eventsRepo, dataSource };
}

describe('RouteBatchReviewerService.assignReviewer', () => {
    it('asigna el lote completo al coordinador con menos lotes pendientes y registra el evento del sistema', async () => {
        const { service, batchRepo, eventsRepo } = build({ coordinator: { id: 4, pending: '1' } });

        const result = await service.assignReviewer(10);

        expect(result).toEqual({ routeBatchId: 10, reviewerUserId: 4, changed: true });
        expect(batchRepo.update).toHaveBeenCalledWith(10, { reviewerUserId: 4 });
        expect(eventsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            routeBatchId: 10, eventType: 'reviewer_assigned', actorUserId: null, actorType: 'system',
            metadata: { to: 4, pendingBatches: 1, mode: 'automatic', trigger: 'batch_created' },
        }));
    });

    it('la consulta cuenta solo lotes provisional, solo coordinadores activos y desempata por menor id', async () => {
        const { service, manager } = build({ coordinator: { id: 4, pending: '0' } });

        await service.assignReviewer(10);

        const call = manager.query.mock.calls.find(([sql]) => /FROM users u/.test(sql))!;
        expect(call[0]).toMatch(/u\.active = TRUE/);
        expect(call[0]).toMatch(/u\.deleted_at IS NULL/);
        expect(call[0]).toMatch(/ORDER BY COUNT\(b\.route_batch_id\) ASC, u\.user_id ASC/);
        expect(call[1]).toEqual(['coordinator', 'provisional']);
    });

    it('serializa la decisión con un lock de transacción y bloquea la fila del lote', async () => {
        const { service, manager } = build({ coordinator: { id: 4, pending: '0' } });

        await service.assignReviewer(10);

        const sqls = manager.query.mock.calls.map(([sql]) => sql as string);
        expect(sqls[0]).toMatch(/FOR UPDATE/);
        expect(sqls.some((s) => /pg_advisory_xact_lock/.test(s))).toBe(true);
    });

    it('sin coordinadores activos deja el lote sin revisor y registra reviewer_unassigned', async () => {
        const { service, batchRepo, eventsRepo } = build({ coordinator: null });

        const result = await service.assignReviewer(10);

        expect(result).toEqual({ routeBatchId: 10, reviewerUserId: null, changed: false });
        expect(batchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'reviewer_unassigned', actorType: 'system', metadata: { reason: 'no_active_coordinators' },
        }));
    });

    it('un lote que ya tiene revisor no se toca ni registra evento', async () => {
        const { service, batchRepo, eventsRepo } = build({ batch: { reviewer_user_id: 9, status: 'provisional' }, coordinator: { id: 4, pending: '0' } });

        const result = await service.assignReviewer(10);

        expect(result).toEqual({ routeBatchId: 10, reviewerUserId: 9, changed: false });
        expect(batchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).not.toHaveBeenCalled();
    });

    it('lote inexistente → ROUTE_BATCH_NOT_FOUND', async () => {
        const { service } = build({ batch: null });
        await expect(service.assignReviewer(10)).rejects.toBeInstanceOf(RouteBatchNotFoundException);
    });

    it.each(['pending_final_review', 'confirmed', 'in_execution', 'closed', 'cancelled'])('lote %s → 409 y no escribe', async (status) => {
        const { service, batchRepo, eventsRepo } = build({ batch: { reviewer_user_id: null, status }, coordinator: { id: 4, pending: '0' } });

        await expect(service.assignReviewer(10)).rejects.toBeInstanceOf(RouteBatchNotProvisionalException);
        expect(batchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).not.toHaveBeenCalled();
    });

    it('usa el manager del planificador cuando se le pasa y no abre otra transacción', async () => {
        const { service, manager, dataSource } = build({ coordinator: { id: 4, pending: '0' } });

        await service.assignReviewer(10, { manager: manager as any });

        expect(dataSource.transaction).not.toHaveBeenCalled();
    });
});
