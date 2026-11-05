// RF-A34, Escenario 2 — ST-26.3: pruebas de la regla de negocio de transición de estado del
// vehículo. Foco explícito de esta subtarea: que el trigger dispare exactamente cuando
// disablesVehicle es true, nunca cuando es false, y nunca si algo no existe. Todo mockeado: sin DB
// ni red. (El comportamiento transaccional real contra Postgres se cubre en
// test/vehicle-maintenances.e2e-spec.ts.)
import { describe, expect, it, vi } from 'vitest';
import { VehicleMaintenancesService } from './vehicle-maintenances.service.js';
import { VehicleNotFoundException, VehicleHasActiveBatchesException } from '../../vehicles/exceptions/index.js';
import { InvalidMaintenanceDateRangeException, InvalidMaintenanceTransitionException, MaintenanceNotFoundException } from '../exceptions/index.js';
import { VehicleIncidentTypeNotFoundException } from '../../vehicle-incident-types/exceptions/index.js';
import { VehicleStatusEnum, MaintenanceStatusEnum } from '../../../../shared/enums/index.js';

const MAINTENANCE_ROW = { id: 1, vehicleId: 7, vehicleIncidentTypeId: 3, description: 'Ruido en frenos', status: 'pending', createdAt: new Date('2026-01-01T00:00:00Z') };
const VEHICLE = (statusName: string) => ({ id: 7, vehicleStatus: { name: statusName } });

function buildService(over: { disablesVehicle?: boolean | null; vehicleExists?: boolean; lockedStatus?: string | null; batchesConflict?: boolean } = {}) {
    const txRepo = { create: vi.fn(() => ({})), save: vi.fn(async (e: any) => ({ id: 1, ...e })) };
    const manager = { getRepository: vi.fn(() => txRepo) };
    const dataSource = { transaction: vi.fn(async (cb: (m: any) => Promise<any>) => cb(manager)) };

    const rawRepo = { findOne: vi.fn().mockResolvedValue(MAINTENANCE_ROW) };

    const vehiclesService = {
        existsById:      vi.fn().mockResolvedValue(over.vehicleExists ?? true),
        setStatusByName: vi.fn(),
        lockStatusById:  vi.fn().mockResolvedValue(over.lockedStatus === undefined ? 'active' : over.lockedStatus),
        assertNoActiveBatches: over.batchesConflict
            ? vi.fn().mockRejectedValue(new VehicleHasActiveBatchesException([{ id: 42, shiftDate: '2026-11-06' }]))
            : vi.fn().mockResolvedValue(undefined),
        findOneById:     vi.fn().mockResolvedValue(VEHICLE(over.disablesVehicle ? 'maintenance' : 'active')),
    };
    const vehicleIncidentTypesService = {
        getDisablesVehicle: vi.fn().mockResolvedValue(over.disablesVehicle === undefined ? true : over.disablesVehicle),
    };

    const service = new VehicleMaintenancesService(dataSource as any, rawRepo as any, vehiclesService as any, vehicleIncidentTypesService as any);
    return { service, dataSource, manager, txRepo, rawRepo, vehiclesService, vehicleIncidentTypesService };
}

const validDto = () => ({ vehicleId: 7, vehicleIncidentTypeId: 3, description: 'Ruido en frenos' });

describe('VehicleMaintenancesService.create — el trigger de transición de estado (RF-A34, Escenario 2)', () => {
    it('disablesVehicle = true → el vehículo pasa a maintenance en la MISMA transacción que el alta', async () => {
        const { service, dataSource, manager, txRepo, vehiclesService } = buildService({ disablesVehicle: true });

        await service.create(validDto());

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(txRepo.save).toHaveBeenCalledTimes(1); // el alta ocurrió
        expect(vehiclesService.setStatusByName).toHaveBeenCalledWith(7, VehicleStatusEnum.MAINTENANCE, { manager });
    });

    it('disablesVehicle = false → se registra el incidente pero el estado del vehículo NO se toca', async () => {
        const { service, txRepo, vehiclesService } = buildService({ disablesVehicle: false });

        await service.create(validDto());

        expect(txRepo.save).toHaveBeenCalledTimes(1); // el alta ocurrió igual
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it('el registro nuevo siempre arranca en pending, sin importar la severidad/disablesVehicle', async () => {
        const { service, txRepo } = buildService({ disablesVehicle: true });

        await service.create(validDto());

        expect(txRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
    });

    it('vehicleId inexistente → VehicleNotFoundException; no se llega a chequear el tipo de incidente ni a guardar nada', async () => {
        const { service, txRepo, vehiclesService, vehicleIncidentTypesService } = buildService({ vehicleExists: false });

        await expect(service.create(validDto())).rejects.toThrow(VehicleNotFoundException);

        expect(vehicleIncidentTypesService.getDisablesVehicle).not.toHaveBeenCalled();
        expect(txRepo.save).not.toHaveBeenCalled();
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it('vehicleIncidentTypeId inexistente → VehicleIncidentTypeNotFoundException; no se guarda nada ni se toca el vehículo', async () => {
        const { service, txRepo, vehiclesService } = buildService({ disablesVehicle: null });

        await expect(service.create(validDto())).rejects.toThrow(VehicleIncidentTypeNotFoundException);

        expect(txRepo.save).not.toHaveBeenCalled();
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it('la respuesta incluye vehicleStatus con el estado real y actual del vehículo, leído después de la transacción', async () => {
        const { service, vehiclesService } = buildService({ disablesVehicle: true });

        const result = await service.create(validDto());

        expect(vehiclesService.findOneById).toHaveBeenCalledWith(expect.anything(), 7, { throwException: false });
        expect(result.vehicleStatus).toBe('maintenance');
    });

    it('vehicleStatus refleja "active" (sin cambios) cuando disablesVehicle es false', async () => {
        const { service } = buildService({ disablesVehicle: false });

        const result = await service.create(validDto());

        expect(result.vehicleStatus).toBe('active');
    });

    it('guarda vehicleId, vehicleIncidentTypeId y description tal cual llegan', async () => {
        const { service, txRepo } = buildService({ disablesVehicle: true });

        await service.create(validDto());

        expect(txRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            vehicleId: 7, vehicleIncidentTypeId: 3, description: 'Ruido en frenos',
        }));
    });
});

describe('VehicleMaintenancesService.create — guarda de lotes comprometidos (ST-62.1 aplicada, ST-64.1 Escenario 3)', () => {
    it('disablesVehicle = true y vehículo active con lote confirmado/en ejecución → 409; nada se guarda ni se cambia', async () => {
        const { service, txRepo, vehiclesService } = buildService({ disablesVehicle: true, batchesConflict: true });

        await expect(service.create(validDto())).rejects.toThrow(VehicleHasActiveBatchesException);

        expect(vehiclesService.lockStatusById).toHaveBeenCalledTimes(1);
        expect(txRepo.save).not.toHaveBeenCalled();
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it('disablesVehicle = true y sin lotes comprometidos → se registra y pasa a maintenance', async () => {
        const { service, txRepo, vehiclesService } = buildService({ disablesVehicle: true });

        await service.create(validDto());

        expect(vehiclesService.assertNoActiveBatches).toHaveBeenCalledWith(7, expect.anything());
        expect(txRepo.save).toHaveBeenCalledTimes(1);
        expect(vehiclesService.setStatusByName).toHaveBeenCalledTimes(1);
    });

    it('disablesVehicle = false → ni se bloquea ni se consulta la guarda (el vehículo no se mueve)', async () => {
        const { service, vehiclesService } = buildService({ disablesVehicle: false, batchesConflict: true });

        await service.create(validDto());

        expect(vehiclesService.lockStatusById).not.toHaveBeenCalled();
        expect(vehiclesService.assertNoActiveBatches).not.toHaveBeenCalled();
    });

    it('vehículo ya en maintenance → no se mueve, así que la guarda no aplica', async () => {
        const { service, txRepo, vehiclesService } = buildService({ disablesVehicle: true, lockedStatus: 'maintenance', batchesConflict: true });

        await service.create(validDto());

        expect(vehiclesService.assertNoActiveBatches).not.toHaveBeenCalled();
        expect(txRepo.save).toHaveBeenCalledTimes(1);
    });

    it('vehículo que desaparece entre el chequeo y el candado → VehicleNotFoundException', async () => {
        const { service, txRepo } = buildService({ disablesVehicle: true, lockedStatus: null });

        await expect(service.create(validDto())).rejects.toThrow(VehicleNotFoundException);
        expect(txRepo.save).not.toHaveBeenCalled();
    });
});

function buildChangeService(over: { maintenance?: { id: number; vehicleId: number } | null; vanishesBeforeLock?: boolean; currentStatus?: string; vehicleStatus?: string | null; otherOpen?: boolean } = {}) {
    const maintenanceRepo = {
        findOne: vi.fn().mockResolvedValue(over.maintenance === undefined ? { id: 5, vehicleId: 7 } : over.maintenance),
        update:  vi.fn(),
    };
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) return over.vanishesBeforeLock ? [] : [{ status: over.currentStatus ?? 'in_progress' }];
        if (sql.includes('LIMIT 1')) return over.otherOpen ? [{ '?column?': 1 }] : [];
        throw new Error(`Unexpected query: ${sql}`);
    });
    const manager = { getRepository: vi.fn(() => maintenanceRepo), query };
    const dataSource = { transaction: vi.fn(async (cb: (m: any) => Promise<any>) => cb(manager)) };
    const rawRepo = { findOne: vi.fn().mockResolvedValue({ ...MAINTENANCE_ROW, id: 5 }) };
    const vehiclesService = {
        lockStatusById:  vi.fn().mockResolvedValue(over.vehicleStatus === undefined ? 'maintenance' : over.vehicleStatus),
        setStatusByName: vi.fn(),
        findOneById:     vi.fn().mockResolvedValue(VEHICLE('active')),
    };
    const service = new VehicleMaintenancesService(dataSource as any, rawRepo as any, vehiclesService as any, {} as any);
    return { service, manager, maintenanceRepo, query, vehiclesService };
}

describe('VehicleMaintenancesService.changeStatus (ST-64.1)', () => {
    it('pending → in_progress: solo cambia el estado, sin completed_at ni tocar el vehículo', async () => {
        const { service, maintenanceRepo, vehiclesService } = buildChangeService({ currentStatus: 'pending' });

        await service.changeStatus(5, { status: MaintenanceStatusEnum.IN_PROGRESS });

        expect(maintenanceRepo.update).toHaveBeenCalledWith(5, { status: 'in_progress' });
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it.each([
        ['pending', 'completed'], ['pending', 'pending'], ['in_progress', 'pending'], ['in_progress', 'in_progress'],
        ['completed', 'pending'], ['completed', 'in_progress'], ['completed', 'completed'],
    ])('%s → %s es una transición inválida (409) y no escribe nada', async (from, to) => {
        const { service, maintenanceRepo, vehiclesService } = buildChangeService({ currentStatus: from });

        await expect(service.changeStatus(5, { status: to as MaintenanceStatusEnum })).rejects.toThrow(InvalidMaintenanceTransitionException);

        expect(maintenanceRepo.update).not.toHaveBeenCalled();
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it('completar sin otro mantenimiento abierto → fija completed_at y devuelve el vehículo a active en la misma transacción', async () => {
        const { service, manager, maintenanceRepo, vehiclesService } = buildChangeService({ otherOpen: false });

        await service.changeStatus(5, { status: MaintenanceStatusEnum.COMPLETED });

        expect(maintenanceRepo.update).toHaveBeenCalledWith(5, { status: 'completed', completedAt: expect.any(Date) });
        expect(vehiclesService.setStatusByName).toHaveBeenCalledWith(7, VehicleStatusEnum.ACTIVE, { manager });
    });

    it('completar con otro mantenimiento abierto → se cierra, pero el vehículo sigue en maintenance', async () => {
        const { service, maintenanceRepo, vehiclesService } = buildChangeService({ otherOpen: true });

        await service.changeStatus(5, { status: MaintenanceStatusEnum.COMPLETED });

        expect(maintenanceRepo.update).toHaveBeenCalledTimes(1);
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it('completar con el vehículo en out_of_service (lo puso así una persona) → no se reactiva solo', async () => {
        const { service, query, vehiclesService } = buildChangeService({ vehicleStatus: 'out_of_service' });

        await service.changeStatus(5, { status: MaintenanceStatusEnum.COMPLETED });

        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledTimes(1); // solo el candado del mantenimiento: ni busca otros abiertos
    });

    it('completar con el vehículo eliminado → se cierra el registro y no se intenta reactivar', async () => {
        const { service, maintenanceRepo, vehiclesService } = buildChangeService({ vehicleStatus: null });

        await service.changeStatus(5, { status: MaintenanceStatusEnum.COMPLETED });

        expect(maintenanceRepo.update).toHaveBeenCalledTimes(1);
        expect(vehiclesService.setStatusByName).not.toHaveBeenCalled();
    });

    it('mantenimiento inexistente → 404 y no se bloquea nada', async () => {
        const { service, vehiclesService } = buildChangeService({ maintenance: null });

        await expect(service.changeStatus(5, { status: MaintenanceStatusEnum.IN_PROGRESS })).rejects.toThrow(MaintenanceNotFoundException);
        expect(vehiclesService.lockStatusById).not.toHaveBeenCalled();
    });

    it('mantenimiento borrado entre la lectura y el candado → 404, no un 500', async () => {
        const { service, maintenanceRepo } = buildChangeService({ vanishesBeforeLock: true });

        await expect(service.changeStatus(5, { status: MaintenanceStatusEnum.IN_PROGRESS })).rejects.toThrow(MaintenanceNotFoundException);
        expect(maintenanceRepo.update).not.toHaveBeenCalled();
    });

    it('bloquea primero el vehículo y después el mantenimiento (mismo orden que create, sin interbloqueos)', async () => {
        const { service, query, vehiclesService } = buildChangeService({ currentStatus: 'pending' });

        await service.changeStatus(5, { status: MaintenanceStatusEnum.IN_PROGRESS });

        expect(vehiclesService.lockStatusById.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
    });
});

describe('VehicleMaintenancesService.findAll (ST-64.1)', () => {
    function buildListService(rows: any[]) {
        const inner = { findAndCount: vi.fn().mockResolvedValue([rows, rows.length]) };
        const service = new VehicleMaintenancesService({} as any, inner as any, {} as any, {} as any);
        return { service, inner };
    }
    const base = { page: 1, limit: 10 };

    it('deriva maintenanceType: sin tipo de incidente → preventive, con tipo → corrective', async () => {
        const { service } = buildListService([
            { id: 1, vehicleIncidentTypeId: null },
            { id: 2, vehicleIncidentTypeId: 3 },
        ]);

        const res = await service.findAll({ ...base });

        expect(res.data.map((d) => d.maintenanceType)).toEqual(['preventive', 'corrective']);
        expect(res.meta).toEqual({ page: 1, limit: 10, total: 2, pages: 1 });
    });

    it('aplica vehicleId y status, ordena por más reciente y conserva vehículos/tipos eliminados', async () => {
        const { service, inner } = buildListService([]);

        await service.findAll({ ...base, vehicleId: 7, status: MaintenanceStatusEnum.PENDING });

        expect(inner.findAndCount).toHaveBeenCalledWith(expect.objectContaining({
            where: { vehicleId: 7, status: 'pending' },
            order: { createdAt: 'DESC', id: 'DESC' },
            withDeleted: true,
        }));
    });

    it('sin filtros no agrega condiciones', async () => {
        const { service, inner } = buildListService([]);
        await service.findAll({ ...base });
        expect(inner.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });

    it('from y to se combinan en una sola condición sobre createdAt', async () => {
        const { service, inner } = buildListService([]);

        await service.findAll({ ...base, from: '2026-11-01', to: '2026-11-05' });

        const where = inner.findAndCount.mock.calls[0][0].where;
        expect(Object.keys(where)).toEqual(['createdAt']);
        const sql = where.createdAt.getSql('m.created_at');
        expect(sql).toContain('>= (:from::date)');
        expect(sql).toContain('< ((:to::date + 1)');
    });

    it('solo from → solo cota inferior; solo to → solo cota superior', async () => {
        const { service, inner } = buildListService([]);

        await service.findAll({ ...base, from: '2026-11-01' });
        await service.findAll({ ...base, to: '2026-11-05' });

        const [onlyFrom, onlyTo] = inner.findAndCount.mock.calls.map((c) => c[0].where.createdAt.getSql('c'));
        expect(onlyFrom).toContain(':from');
        expect(onlyFrom).not.toContain(':to');
        expect(onlyTo).toContain(':to');
        expect(onlyTo).not.toContain(':from');
    });

    it('from posterior a to → 400 INVALID_MAINTENANCE_DATE_RANGE sin consultar', async () => {
        const { service, inner } = buildListService([]);

        await expect(service.findAll({ ...base, from: '2026-11-06', to: '2026-11-05' })).rejects.toThrow(InvalidMaintenanceDateRangeException);
        expect(inner.findAndCount).not.toHaveBeenCalled();
    });
});
