import { describe, expect, it, vi } from 'vitest';
import { RouteBatchCorrectionController } from './route-batch-correction.controller.js';

describe('RouteBatchCorrectionController', () => {
    it('delegates the driver change with the batch, the driver, the expected version and the actor of the token', async () => {
        const correction = { changeDriver: vi.fn().mockResolvedValue({ routeBatchId: 5, version: 3, changed: true }) };
        const controller = new RouteBatchCorrectionController(correction as any);

        await expect(controller.changeDriver(5, { driverId: 34, version: 2 }, 9)).resolves.toMatchObject({ routeBatchId: 5, version: 3 });
        expect(correction.changeDriver).toHaveBeenCalledWith(5, 34, 2, 9);
    });

    it('delegates the vehicle change with the batch, the vehicle, the expected version, actor and reason', async () => {
        const correction = { changeVehicle: vi.fn().mockResolvedValue({ routeBatchId: 5, vehicleId: 8 }) };
        const controller = new RouteBatchCorrectionController(correction as any);

        await expect(controller.changeVehicle(5, { vehicleId: 8, version: 2, reason: 'Vehicle fault' }, 9)).resolves.toMatchObject({ vehicleId: 8 });
        expect(correction.changeVehicle).toHaveBeenCalledWith(5, 8, 2, 9, 'Vehicle fault');
    });
});
