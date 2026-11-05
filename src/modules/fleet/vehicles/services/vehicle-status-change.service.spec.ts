import { describe, expect, it, vi } from 'vitest';
import { Vehicle } from '../entities/vehicle.entity.js';
import { VehicleStatus } from '../../vehicle-statuses/entities/vehicle-status.entity.js';
import { AuditLog } from '../../../audit/audit-logs/entities/audit-log.entity.js';
import { ChangeVehicleStatusDto } from '../dto/change-vehicle-status.dto.js';
import { VehicleStatusEnum } from '../../../../shared/enums/index.js';
import { VehicleHasActiveBatchesException } from '../exceptions/vehicle-has-active-batches.exception.js';
import { VehiclesService } from './vehicles.service.js';

const STATUS_IDS: Record<VehicleStatusEnum, number> = {
    [VehicleStatusEnum.ACTIVE]: 1,
    [VehicleStatusEnum.MAINTENANCE]: 2,
    [VehicleStatusEnum.OUT_OF_SERVICE]: 3,
};

function setup(initialStatus: VehicleStatusEnum = VehicleStatusEnum.ACTIVE, activeBatches: object[] = []) {
    let status = initialStatus;
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM vehicles v')) return [{ status }];
        if (sql.includes('FROM route_batches')) return activeBatches;
        throw new Error(`Unexpected query: ${sql}`);
    });
    const vehicleRepository = {
        existsBy: vi.fn().mockResolvedValue(true),
        update: vi.fn(async (_id: number, values: { vehicleStatusId: number }) => {
            status = Object.entries(STATUS_IDS).find(([, id]) => id === values.vehicleStatusId)![0] as VehicleStatusEnum;
        }),
        findOne: vi.fn(async () => ({
            id: 12,
            type: 'camioneta',
            model: 'Toyota Hilux',
            plate: 'ABC-123',
            capacityKg: 1000,
            capacityM3: 5,
            vehicleStatus: { id: STATUS_IDS[status], name: status },
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        })),
    };
    const statusRepository = {
        findOneByOrFail: vi.fn(async ({ name }: { name: VehicleStatusEnum }) => ({ id: STATUS_IDS[name], name })),
    };
    const auditRepository = {
        create: vi.fn((entry: object) => entry),
        save: vi.fn(async (entry: object) => entry),
    };
    const manager = {
        query,
        getRepository: vi.fn((entity: unknown) => {
            if (entity === Vehicle) return vehicleRepository;
            if (entity === VehicleStatus) return statusRepository;
            if (entity === AuditLog) return auditRepository;
            throw new Error('Unexpected repository');
        }),
    };
    const rawRepo = {
        manager: {
            transaction: vi.fn(async (callback: (transactionManager: typeof manager) => Promise<unknown>) => callback(manager)),
        },
    };
    const service = new VehiclesService(rawRepo as any, statusRepository as any);
    return { service, manager, query, vehicleRepository, statusRepository, auditRepository };
}

describe('VehiclesService.changeStatus', () => {
    it('changes status through setStatusByName and records the actor, both states and reason', async () => {
        const { service, query, vehicleRepository, auditRepository } = setup();
        const dto: ChangeVehicleStatusDto = { status: VehicleStatusEnum.MAINTENANCE, reason: 'Inspection found a fault.' };

        const result = await service.changeStatus(12, dto, 8);

        expect(query).toHaveBeenCalledTimes(2);
        expect(vehicleRepository.update).toHaveBeenCalledWith(12, { vehicleStatusId: STATUS_IDS[VehicleStatusEnum.MAINTENANCE] });
        expect(result.vehicleStatus.name).toBe('maintenance');
        expect(auditRepository.save).toHaveBeenCalledWith(expect.objectContaining({
            userId: 8,
            action: 'vehicle_status_changed',
            detail: JSON.stringify({
                vehicleId: 12,
                previousStatus: 'active',
                newStatus: 'maintenance',
                reason: 'Inspection found a fault.',
            }),
        }));
    });

    it('rejects a committed batch without changing the vehicle or writing audit', async () => {
        const batches = [{ id: 41, shiftDate: '2026-11-06' }];
        const { service, vehicleRepository, auditRepository } = setup(VehicleStatusEnum.ACTIVE, batches);

        await expect(service.changeStatus(12, {
            status: VehicleStatusEnum.OUT_OF_SERVICE,
            reason: 'Unsafe to drive.',
        }, 8)).rejects.toBeInstanceOf(VehicleHasActiveBatchesException);

        expect(vehicleRepository.update).not.toHaveBeenCalled();
        expect(auditRepository.save).not.toHaveBeenCalled();
    });

    it('reactivates a vehicle without running the active-batch guard', async () => {
        const { service, query, auditRepository } = setup(VehicleStatusEnum.MAINTENANCE, [{ id: 99, shiftDate: '2026-11-06' }]);

        const result = await service.changeStatus(12, {
            status: VehicleStatusEnum.ACTIVE,
            reason: 'Repairs completed.',
        }, 8);

        expect(result.vehicleStatus.name).toBe('active');
        expect(query).toHaveBeenCalledTimes(1);
        expect(auditRepository.save).toHaveBeenCalledOnce();
    });

    it('keeps setStatusByName usable for the existing maintenance incident flow', async () => {
        const { service, manager, vehicleRepository, auditRepository } = setup();

        await service.setStatusByName(12, VehicleStatusEnum.MAINTENANCE, { manager: manager as any });

        expect(vehicleRepository.update).toHaveBeenCalledWith(12, { vehicleStatusId: STATUS_IDS[VehicleStatusEnum.MAINTENANCE] });
        expect(auditRepository.save).not.toHaveBeenCalled();
    });
});
