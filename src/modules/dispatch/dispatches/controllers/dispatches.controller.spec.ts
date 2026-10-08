// ST-28.4 — DispatchesController: el repartidor sale siempre del token y, sin fecha, se usa "hoy" de La Paz.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatchesController } from './dispatches.controller.js';

function build() {
    const service = { findDriverAssignments: vi.fn().mockResolvedValue({ date: 'x', lastModifiedAt: null, data: [] }) };
    return { controller: new DispatchesController(service as any), service };
}

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
