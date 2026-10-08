// ST-23.3 — DispatchesService: la consulta de "despachos activos" que protege el borrado de niveles
// de servicio (RF-A31, Escenario 3). Todo mockeado: sin DB ni red.
// ST-77.3 — updateLocation (RF-U11): el UPDATE condicional que solo escribe si el punto es más nuevo.
// ST-28.4 — findDriverAssignments (RF-U02): las paradas del repartidor para un día, en orden de visita.
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
        find:             vi.fn().mockResolvedValue([]),
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

// Una fila tal como la devuelve TypeORM: NUMERIC llega como string, las relaciones anidadas.
function stopRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1, sequenceOrder: 1, sourceOrderRef: 'SO-1', priority: 'normal', deliveryAddress: 'Av. Arce 100',
        deliveryLatitude: '-16.500000', deliveryLongitude: '-68.150000', contactName: 'Maria', contactPhone: '+59170000000',
        paymentStatusLabel: 'Prepaid', packageContents: null, estimatedWeightKg: '12.50',
        scheduledWindowStart: new Date('2026-10-14T14:00:00Z'), scheduledWindowEnd: new Date('2026-10-14T16:00:00Z'),
        dispatchStatus: { id: 2, name: 'in_transit' }, serviceLevel: { id: 1, name: 'express' },
        updatedAt: new Date('2026-10-14T10:00:00Z'),
        ...overrides,
    };
}

describe('DispatchesService.findDriverAssignments', () => {
    it('filtra por la ruta de ESE repartidor en ESE día y ordena por parada, con las paradas sin número al final', async () => {
        const { service, rawRepo } = buildService();

        await service.findDriverAssignments(9, '2026-10-14');

        expect(rawRepo.find).toHaveBeenCalledTimes(1);
        const [{ where, order }] = rawRepo.find.mock.calls[0];
        expect(where).toEqual({ routeBatch: { driverId: 9, shiftDate: '2026-10-14' } });
        expect(order).toEqual({ sequenceOrder: { direction: 'ASC', nulls: 'LAST' }, id: 'ASC' });
    });

    it('un repartidor sin ruta recibe una lista vacía y lastModifiedAt nulo, no un error', async () => {
        const { service } = buildService();

        expect(await service.findDriverAssignments(9, '2026-10-14')).toEqual({ date: '2026-10-14', lastModifiedAt: null, data: [] });
    });

    it('devuelve coordenadas y peso como números (pg los entrega como string) y no filtra campos internos', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.find.mockResolvedValue([stopRow({ trackingToken: 'secret', routeBatchId: 5 })]);

        const { data } = await service.findDriverAssignments(9, '2026-10-14');

        expect(data[0].deliveryLatitude).toBe(-16.5);
        expect(data[0].deliveryLongitude).toBe(-68.15);
        expect(data[0].estimatedWeightKg).toBe(12.5);
        expect(data[0]).not.toHaveProperty('trackingToken');
        expect(data[0]).not.toHaveProperty('routeBatchId');
        expect(data[0].dispatchStatus).toEqual({ id: 2, name: 'in_transit' });
    });

    it('conserva null en coordenadas, peso y nivel de servicio ausentes', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.find.mockResolvedValue([stopRow({ deliveryLatitude: null, deliveryLongitude: null, estimatedWeightKg: null, serviceLevel: null })]);

        const { data } = await service.findDriverAssignments(9, '2026-10-14');

        expect(data[0].deliveryLatitude).toBeNull();
        expect(data[0].deliveryLongitude).toBeNull();
        expect(data[0].estimatedWeightKg).toBeNull();
        expect(data[0].serviceLevel).toBeNull();
    });

    it('lastModifiedAt es el updatedAt más reciente de las paradas, sin importar su posición en la lista', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.find.mockResolvedValue([
            stopRow({ id: 1, sequenceOrder: 1, updatedAt: new Date('2026-10-14T10:00:00Z') }),
            stopRow({ id: 2, sequenceOrder: 2, updatedAt: new Date('2026-10-14T12:30:00Z') }),
            stopRow({ id: 3, sequenceOrder: 3, updatedAt: new Date('2026-10-14T11:00:00Z') }),
        ]);

        const result = await service.findDriverAssignments(9, '2026-10-14');

        expect(result.lastModifiedAt).toEqual(new Date('2026-10-14T12:30:00Z'));
        expect(result.data.map((stop) => stop.id)).toEqual([1, 2, 3]);
    });
});
