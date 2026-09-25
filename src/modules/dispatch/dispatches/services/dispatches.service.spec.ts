// ST-23.3 — DispatchesService: la consulta de "despachos activos" que protege el borrado de niveles
// de servicio (RF-A31, Escenario 3). Todo mockeado: sin DB ni red.
import { describe, expect, it, vi } from 'vitest';
import { DispatchesService } from './dispatches.service.js';
import { DispatchNotFoundException } from '../exceptions/index.js';

function buildService() {
    const rawRepo = {
        exists:   vi.fn().mockResolvedValue(false),
        existsBy: vi.fn().mockResolvedValue(true),
        update:   vi.fn(),
    };
    const service = new DispatchesService(rawRepo as any);
    return { service, rawRepo };
}

describe('DispatchesService.hasActiveByServiceLevel', () => {
    it('pregunta por despachos de ESE nivel de servicio cuyo estado es pending o in_transit, y solo esos', async () => {
        const { service, rawRepo } = buildService();

        await service.hasActiveByServiceLevel(7);

        expect(rawRepo.exists).toHaveBeenCalledTimes(1);
        const [{ where }] = rawRepo.exists.mock.calls[0];
        expect(where.serviceLevelId).toBe(7);
        expect(where.dispatchStatus.name.type).toBe('in');
        // Conjunto exacto: si alguien agrega delivered/returned/not_delivered, este test avisa.
        expect([...where.dispatchStatus.name.value].sort()).toEqual(['in_transit', 'pending']);
    });

    it('devuelve lo que responde la base', async () => {
        const { service, rawRepo } = buildService();

        rawRepo.exists.mockResolvedValueOnce(true);
        expect(await service.hasActiveByServiceLevel(1)).toBe(true);
        rawRepo.exists.mockResolvedValueOnce(false);
        expect(await service.hasActiveByServiceLevel(1)).toBe(false);
    });

    it('dentro de una transacción usa el repositorio del manager, no el global', async () => {
        const { service, rawRepo } = buildService();
        const txRepo = { exists: vi.fn().mockResolvedValue(true) };
        const manager = { getRepository: vi.fn().mockReturnValue(txRepo) };

        expect(await service.hasActiveByServiceLevel(3, { manager } as any)).toBe(true);

        expect(txRepo.exists).toHaveBeenCalledTimes(1);
        expect(rawRepo.exists).not.toHaveBeenCalled();
    });
});

describe('DispatchesService.updateStatus / existsById', () => {
    it('cambia el estado de un despacho que existe', async () => {
        const { service, rawRepo } = buildService();

        await service.updateStatus(5, 3);

        expect(rawRepo.update).toHaveBeenCalledWith(5, { dispatchStatusId: 3 });
    });

    it('un despacho inexistente → DispatchNotFoundException y no actualiza nada', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(false);

        await expect(service.updateStatus(99, 3)).rejects.toThrow(DispatchNotFoundException);
        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('existsById consulta por id', async () => {
        const { service, rawRepo } = buildService();
        await service.existsById(12);
        expect(rawRepo.existsBy).toHaveBeenCalledWith({ id: 12 });
    });
});
