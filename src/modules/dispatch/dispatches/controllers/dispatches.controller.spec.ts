// ST-28.4 — DispatchesController: el repartidor sale siempre del token y, sin fecha, se usa "hoy" de La Paz.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatchesController } from './dispatches.controller.js';

function build() {
    const service = { findDriverAssignments: vi.fn().mockResolvedValue({ date: 'x', lastModifiedAt: null, data: [] }) };
    const priority = { changePriority: vi.fn().mockResolvedValue({ id: 5, priority: 'urgent', status: 'pending' }) };
    return { controller: new DispatchesController(service as any, priority as any), service, priority };
}

// ST-58.2 — el usuario que cambia la prioridad sale siempre del token.
describe('DispatchesController.changePriority', () => {
    it('delega en el servicio con el id, la prioridad pedida y el usuario del token', async () => {
        const { controller, priority } = build();

        const result = await controller.changePriority(5, { priority: 'urgent' as any }, 9);

        expect(priority.changePriority).toHaveBeenCalledWith(5, 'urgent', 9);
        expect(result).toEqual({ id: 5, priority: 'urgent', status: 'pending' });
    });
});

describe('DispatchesController.findMyAssignments', () => {
    afterEach(() => vi.useRealTimers());

    it('usa la fecha indicada y el id del repartidor del token', async () => {
        const { controller, service } = build();

        await controller.findMyAssignments({ date: '2026-10-20' }, 7);

        expect(service.findDriverAssignments).toHaveBeenCalledWith(7, '2026-10-20');
    });

    it('sin fecha usa el día actual de America/La_Paz, no el del servidor', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-15T00:30:00Z')); // 20:30 del 14 en La Paz
        const { controller, service } = build();

        await controller.findMyAssignments({}, 7);

        expect(service.findDriverAssignments).toHaveBeenCalledWith(7, '2026-10-14');
    });
});
