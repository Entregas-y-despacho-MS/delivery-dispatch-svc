// ST-58.2 — DispatchPriorityService: cambio manual de prioridad (RF-A11). Todo mockeado: sin DB ni red.
import { describe, expect, it, vi } from 'vitest';
import { DispatchPriorityService } from './dispatch-priority.service.js';
import { DispatchNotFoundException, DispatchPriorityNotChangeableException } from '../exceptions/index.js';
import { DispatchPriority } from '../dto/update-dispatch-priority.dto.js';

function build(row: { priority: string; status: string } | null) {
    const dispatchRepo = { update: vi.fn().mockResolvedValue(undefined) };
    const eventsRepo = {
        create: vi.fn((data: object) => data),
        save:   vi.fn().mockResolvedValue(undefined),
    };
    const manager = {
        query:         vi.fn().mockResolvedValue(row ? [row] : []),
        getRepository: vi.fn((entity: { name: string }) => (entity.name === 'DispatchEvent' ? eventsRepo : dispatchRepo)),
    };
    const dataSource = { transaction: vi.fn(async (fn: (m: unknown) => unknown) => fn(manager)) };
    return { service: new DispatchPriorityService(dataSource as any), manager, dispatchRepo, eventsRepo };
}

describe('DispatchPriorityService.changePriority', () => {
    it.each(['pending', 'in_planning', 'scheduled'])('cambia la prioridad de un despacho %s y registra el evento con el usuario', async (status) => {
        const { service, dispatchRepo, eventsRepo } = build({ priority: 'normal', status });

        const result = await service.changePriority(12, DispatchPriority.URGENT, 7);

        expect(result).toEqual({ id: 12, priority: 'urgent', status });
        expect(dispatchRepo.update).toHaveBeenCalledWith(12, { priority: 'urgent' });
        expect(eventsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            dispatchId: 12, eventType: 'priority_changed', actorUserId: 7, actorType: 'user', metadata: { from: 'normal', to: 'urgent' },
        }));
    });

    it('solo escribe la columna priority: ni ventana, ni SLA, ni estado', async () => {
        const { service, dispatchRepo } = build({ priority: 'urgent', status: 'pending' });

        await service.changePriority(12, DispatchPriority.NORMAL, 7);

        expect(Object.keys(dispatchRepo.update.mock.calls[0][1])).toEqual(['priority']);
    });

    it('bloquea la fila del despacho dentro de la transacción', async () => {
        const { service, manager } = build({ priority: 'normal', status: 'pending' });

        await service.changePriority(12, DispatchPriority.URGENT, 7);

        expect(manager.query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
    });

    it.each(['assigned', 'in_transit', 'delivered', 'cancelled', 'rescheduled', 'address_review'])('en estado %s responde 409 y no escribe', async (status) => {
        const { service, dispatchRepo, eventsRepo } = build({ priority: 'normal', status });

        await expect(service.changePriority(12, DispatchPriority.URGENT, 7)).rejects.toBeInstanceOf(DispatchPriorityNotChangeableException);
        expect(dispatchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).not.toHaveBeenCalled();
    });

    it('con la misma prioridad responde igual y no escribe ni registra evento', async () => {
        const { service, dispatchRepo, eventsRepo } = build({ priority: 'urgent', status: 'pending' });

        const result = await service.changePriority(12, DispatchPriority.URGENT, 7);

        expect(result).toEqual({ id: 12, priority: 'urgent', status: 'pending' });
        expect(dispatchRepo.update).not.toHaveBeenCalled();
        expect(eventsRepo.save).not.toHaveBeenCalled();
    });

    it('un despacho inexistente responde 404', async () => {
        const { service } = build(null);

        await expect(service.changePriority(999, DispatchPriority.URGENT, 7)).rejects.toBeInstanceOf(DispatchNotFoundException);
    });
});
