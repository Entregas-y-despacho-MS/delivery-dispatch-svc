import { describe, expect, it, vi } from 'vitest';
import { OperationalAlertsController } from './operational-alerts.controller.js';

function build() {
    const alerts = { findAll: vi.fn(), acknowledge: vi.fn() };
    const controller = new OperationalAlertsController(alerts as never);
    return { controller, alerts };
}

describe('OperationalAlertsController', () => {
    it('findAll delegates to the service with the query params', async () => {
        const { controller, alerts } = build();
        alerts.findAll.mockResolvedValue({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });

        const params = { status: 'open' } as never;
        const result = await controller.findAll(params);

        expect(alerts.findAll).toHaveBeenCalledWith(expect.any(Function), params);
        expect(result).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
    });

    it('acknowledge delegates to the service with the id and the current user', async () => {
        const { controller, alerts } = build();
        const dto = { id: 1, status: 'acknowledged' };
        alerts.acknowledge.mockResolvedValue(dto);

        const result = await controller.acknowledge(1, 9);

        expect(alerts.acknowledge).toHaveBeenCalledWith(1, 9);
        expect(result).toBe(dto);
    });
});
