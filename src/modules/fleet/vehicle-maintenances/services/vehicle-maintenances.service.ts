import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, Raw, Repository } from 'typeorm';
import { VehicleMaintenance } from '../entities/vehicle-maintenance.entity.js';
import { VehicleMaintenanceDto } from '../dto/vehicle-maintenance.dto.js';
import { CreateVehicleMaintenanceDto } from '../dto/create-vehicle-maintenance.dto.js';
import { ChangeMaintenanceStatusDto } from '../dto/change-maintenance-status.dto.js';
import { FindVehicleMaintenancesParamsDto } from '../dto/find-vehicle-maintenances-params.dto.js';
import { VehicleMaintenanceItemDto } from '../dto/vehicle-maintenance-item.dto.js';
import { InvalidMaintenanceDateRangeException, InvalidMaintenanceTransitionException, MaintenanceNotFoundException } from '../exceptions/index.js';
import { VehiclesService } from '../../vehicles/services/vehicles.service.js';
import { VehicleDto } from '../../vehicles/dto/vehicle.dto.js';
import { VehicleNotFoundException } from '../../vehicles/exceptions/index.js';
import { VehicleIncidentTypesService } from '../../vehicle-incident-types/services/vehicle-incident-types.service.js';
import { VehicleIncidentTypeNotFoundException } from '../../vehicle-incident-types/exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { MaintenanceStatusEnum, VehicleStatusEnum } from '../../../../shared/enums/index.js';
import { OPERATING_TIME_ZONE } from '../../../dispatch/dispatches/utils/operating-date.util.js';

// The only forward moves a maintenance can make (ST-64.1).
const ALLOWED_TRANSITIONS: Record<string, MaintenanceStatusEnum | undefined> = {
    [MaintenanceStatusEnum.PENDING]:     MaintenanceStatusEnum.IN_PROGRESS,
    [MaintenanceStatusEnum.IN_PROGRESS]: MaintenanceStatusEnum.COMPLETED,
};

/**
 * RF-A34 (register an incident, moving the vehicle to `maintenance` when the type disables it) and
 * RF-A17 (history, progress and closing of maintenances, which gives the vehicle back to `active`).
 */
@Injectable()
export class VehicleMaintenancesService {
    private readonly repo: DtoRepository<VehicleMaintenance>;

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        @InjectRepository(VehicleMaintenance)
        private readonly rawRepo: Repository<VehicleMaintenance>,
        private readonly vehiclesService: VehiclesService,
        private readonly vehicleIncidentTypesService: VehicleIncidentTypesService,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    async findAll(params: FindVehicleMaintenancesParamsDto): Promise<PaginationResponseDto<VehicleMaintenanceItemDto>> {
        if (params.from && params.to && params.from > params.to) throw new InvalidMaintenanceDateRangeException();

        // Whole Bolivia days: `from` starts at 00:00 of its day, `to` includes all of its day.
        const where: FindOptionsWhere<VehicleMaintenance> = {
            ...(params.vehicleId !== undefined && { vehicleId: params.vehicleId }),
            ...(params.status !== undefined && { status: params.status }),
        };
        // `from` and `to` both target createdAt, which one key cannot hold twice: a single Raw with both bounds.
        if (params.from || params.to) {
            where.createdAt = Raw((col) => [
                params.from ? `${col} >= (:from::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'` : null,
                params.to   ? `${col} < ((:to::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')` : null,
            ].filter(Boolean).join(' AND '), { from: params.from, to: params.to });
        }

        // withDeleted: the history keeps showing the vehicle / incident type even if they were removed later.
        const page = await this.repo.findPaginated({
            dto: VehicleMaintenanceItemDto,
            pagination: params,
            where,
            order: { createdAt: 'DESC', id: 'DESC' },
            withDeleted: true,
        });

        return {
            ...page,
            data: page.data.map((item) => ({
                ...item,
                maintenanceType: item.vehicleIncidentTypeId === null ? 'preventive' : 'corrective',
            })),
        };
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    async create(dto: CreateVehicleMaintenanceDto): Promise<VehicleMaintenanceDto> {
        const savedId = await this.dataSource.transaction(async (manager) => {
            const options = { manager };

            if (!(await this.vehiclesService.existsById(dto.vehicleId, options))) throw new VehicleNotFoundException();

            const disablesVehicle = await this.vehicleIncidentTypesService.getDisablesVehicle(dto.vehicleIncidentTypeId, options);
            if (disablesVehicle === null) throw new VehicleIncidentTypeNotFoundException();

            // ST-62.1 rule: a vehicle with a confirmed / in-execution batch cannot be moved to `maintenance`.
            // Lock first, so a batch confirmed or a status changed meanwhile cannot slip in between check and write.
            // A vehicle already in `maintenance` does not move, so there is nothing to guard.
            if (disablesVehicle) {
                const current = await this.vehiclesService.lockStatusById(dto.vehicleId, manager);
                if (current === null) throw new VehicleNotFoundException();
                if (current !== VehicleStatusEnum.MAINTENANCE) await this.vehiclesService.assertNoActiveBatches(dto.vehicleId, manager);
            }

            const repo = manager.getRepository(VehicleMaintenance);
            const maintenance             = repo.create();
            maintenance.vehicleId          = dto.vehicleId;
            maintenance.vehicleIncidentTypeId = dto.vehicleIncidentTypeId;
            maintenance.description         = dto.description;
            maintenance.status              = MaintenanceStatusEnum.PENDING;

            const saved = await repo.save(maintenance);

            // RF-A34, Escenario 2 — same transaction as the insert above: either both writes land, or neither does.
            if (disablesVehicle) {
                await this.vehiclesService.setStatusByName(dto.vehicleId, VehicleStatusEnum.MAINTENANCE, options);
            }

            return saved.id;
        });

        return this.toResponse(savedId, dto.vehicleId);
    }

    /**
     * pending → in_progress → completed, nothing else (409). Completing sets `completed_at` and, in
     * the same transaction, gives the vehicle back to `active` when it is in `maintenance` and has no
     * other open maintenance. Lock order is always vehicle → maintenance (like create()), so
     * concurrent closings of two maintenances of one vehicle serialize on the vehicle and exactly the
     * last one reactivates it.
     */
    async changeStatus(id: number, dto: ChangeMaintenanceStatusDto): Promise<VehicleMaintenanceDto> {
        const vehicleId = await this.dataSource.transaction(async (manager) => {
            const head = await manager.getRepository(VehicleMaintenance).findOne({ where: { id }, select: { id: true, vehicleId: true } });
            if (!head) throw new MaintenanceNotFoundException();

            const vehicleStatus = await this.vehiclesService.lockStatusById(head.vehicleId, manager);

            const rows = await manager.query(
                `SELECT status FROM vehicle_maintenances WHERE vehicle_maintenance_id = $1 FOR UPDATE`,
                [id],
            ) as { status: string }[];
            if (rows.length === 0) throw new MaintenanceNotFoundException(); // deleted between the read and the lock
            const current = rows[0].status;

            if (ALLOWED_TRANSITIONS[current] !== dto.status) throw new InvalidMaintenanceTransitionException(current, dto.status);

            const completing = dto.status === MaintenanceStatusEnum.COMPLETED;
            await manager.getRepository(VehicleMaintenance).update(id, {
                status: dto.status,
                ...(completing && { completedAt: new Date() }),
            });

            // A removed vehicle (vehicleStatus === null) is left alone: there is nothing to give back.
            if (completing && vehicleStatus === VehicleStatusEnum.MAINTENANCE) {
                const others = await manager.query(
                    `SELECT 1 FROM vehicle_maintenances
                     WHERE vehicle_id = $1 AND vehicle_maintenance_id <> $2 AND status <> $3
                     LIMIT 1`,
                    [head.vehicleId, id, MaintenanceStatusEnum.COMPLETED],
                ) as unknown[];

                if (others.length === 0) {
                    await this.vehiclesService.setStatusByName(head.vehicleId, VehicleStatusEnum.ACTIVE, { manager });
                }
            }

            return head.vehicleId;
        });

        return this.toResponse(id, vehicleId);
    }

    // ── Private implementation ────────────────────────────────────────────────

    private async toResponse(maintenanceId: number, vehicleId: number): Promise<VehicleMaintenanceDto> {
        const maintenance = await new DtoRepository(this.rawRepo).findOne({ dto: VehicleMaintenanceDto, where: { id: maintenanceId } });
        const vehicle      = await this.vehiclesService.findOneById(VehicleDto, vehicleId, { throwException: false });

        // A vehicle removed after the write would be null here; the record itself is what matters.
        return { ...maintenance!, vehicleStatus: vehicle?.vehicleStatus.name ?? '' };
    }
}
