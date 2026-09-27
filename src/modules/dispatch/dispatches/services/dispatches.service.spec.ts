// ST-23.3 — DispatchesService: la consulta de "despachos activos" que protege el borrado de niveles
// de servicio (RF-A31, Escenario 3). Todo mockeado: sin DB ni red.
// ST-77.3 — updateLocation (RF-U11): el UPDATE condicional que solo escribe si el punto es más nuevo.
import { describe, expect, it, vi } from 'vitest';
import { DispatchesService } from './dispatches.service.js';
import { DispatchNotFoundException } from '../exceptions/index.js';

function makeQueryBuilder(affected: number) {
    const qb: any = {
        update:    vi.fn(() => qb),
        set:       vi.fn(() => qb),
        where:     vi.fn(() => qb),
        andWhere:  vi.fn(() => qb),
        execute:   vi.fn().mockResolvedValue({ affected }),
    };
    return qb;
}

function buildService() {
    const rawRepo = {
        exists:           vi.fn().mockResolvedValue(false),
        existsBy:         vi.fn().mockResolvedValue(true),
        update:           vi.fn(),
        createQueryBuilder: vi.fn(() => makeQueryBuilder(1)),
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

describe('DispatchesService.updateLocation', () => {
    it('escribe lat/lng/recordedAt y devuelve true cuando el UPDATE afecta una fila', async () => {
        const { service, rawRepo } = buildService();
        const recordedAt = new Date('2026-09-29T14:00:00.000Z');

        const applied = await service.updateLocation(42, { latitude: -17.783, longitude: -63.182, recordedAt });

        expect(applied).toBe(true);
        const qb = rawRepo.createQueryBuilder.mock.results[0].value;
        expect(qb.set).toHaveBeenCalledWith({ lastLatitude: -17.783, lastLongitude: -63.182, lastLocationAt: recordedAt });
    });

    it('el WHERE apunta al despacho y el guardrail compara contra last_location_at', async () => {
        const { service, rawRepo } = buildService();
        const recordedAt = new Date('2026-09-29T14:00:00.000Z');

        await service.updateLocation(42, { latitude: 1, longitude: 2, recordedAt });

        const qb = rawRepo.createQueryBuilder.mock.results[0].value;
        expect(qb.where).toHaveBeenCalledWith('dispatch_id = :id', { id: 42 });
        expect(qb.andWhere).toHaveBeenCalledWith('(last_location_at IS NULL OR last_location_at < :recordedAt)', { recordedAt });
    });

    it('devuelve false (no es un error) cuando el guardrail rechaza el punto por viejo', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.createQueryBuilder.mockReturnValueOnce(makeQueryBuilder(0));

        expect(await service.updateLocation(42, { latitude: 1, longitude: 2, recordedAt: new Date() })).toBe(false);
    });

    it('dentro de una transacción usa el repositorio del manager, no el global', async () => {
        const { service, rawRepo } = buildService();
        const txQb = makeQueryBuilder(1);
        const txRepo = { createQueryBuilder: vi.fn(() => txQb) };
        const manager = { getRepository: vi.fn().mockReturnValue(txRepo) };

        expect(await service.updateLocation(1, { latitude: 1, longitude: 2, recordedAt: new Date() }, { manager } as any)).toBe(true);

        expect(txRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
        expect(rawRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
});
