// RF-A34, Escenario 2 — ST-26.3: pruebas de la regla de negocio de transición de estado del
// vehículo. Foco explícito de esta subtarea: que el trigger dispare exactamente cuando
// disablesVehicle es true, nunca cuando es false, y nunca si algo no existe. Todo mockeado: sin DB
// ni red. (El comportamiento transaccional real contra Postgres se cubre en
// test/vehicle-maintenances.e2e-spec.ts.)
import { describe, expect, it, vi } from 'vitest';
import { VehicleMaintenancesService } from './vehicle-maintenances.service.js';
import { VehicleNotFoundException } from '../../vehicles/exceptions/index.js';
import { VehicleIncidentTypeNotFoundException } from '../../vehicle-incident-types/exceptions/index.js';
import { VehicleStatusEnum } from '../../../../shared/enums/index.js';

const MAINTENANCE_ROW = { id: 1, vehicleId: 7, vehicleIncidentTypeId: 3, description: 'Ruido en frenos', status: 'pending', createdAt: new Date('2026-01-01T00:00:00Z') };
const VEHICLE = (statusName: string) => ({ id: 7, vehicleStatus: { name: statusName } });

function buildService(over: { disablesVehicle?: boolean | null; vehicleExists?: boolean } = {}) {
    const txRepo = { create: vi.fn(() => ({})), save: vi.fn(async (e: any) => ({ id: 1, ...e })) };
    const manager = { getRepository: vi.fn(() => txRepo) };
    const dataSource = { transaction: vi.fn(async (cb: (m: any) => Promise<any>) => cb(manager)) };

    const rawRepo = { findOne: vi.fn().mockResolvedValue(MAINTENANCE_ROW) };

    const vehiclesService = {
        existsById:      vi.fn().mockResolvedValue(over.vehicleExists ?? true),
        setStatusByName: vi.fn(),
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

        expect(vehiclesService.findOneById).toHaveBeenCalledWith(expect.anything(), 7);
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
