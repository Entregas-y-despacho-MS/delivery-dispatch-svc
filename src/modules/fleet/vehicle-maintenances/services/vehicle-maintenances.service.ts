import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { VehicleMaintenance } from '../entities/vehicle-maintenance.entity.js';
import { VehicleMaintenanceDto } from '../dto/vehicle-maintenance.dto.js';
import { CreateVehicleMaintenanceDto } from '../dto/create-vehicle-maintenance.dto.js';
import { VehiclesService } from '../../vehicles/services/vehicles.service.js';
import { VehicleDto } from '../../vehicles/dto/vehicle.dto.js';
import { VehicleNotFoundException } from '../../vehicles/exceptions/index.js';
import { VehicleIncidentTypesService } from '../../vehicle-incident-types/services/vehicle-incident-types.service.js';
import { VehicleIncidentTypeNotFoundException } from '../../vehicle-incident-types/exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { VehicleStatusEnum } from '../../../../shared/enums/index.js';

/**
 * RF-A34, Escenario 2 — the minimal slice of vehicle_maintenances this story needs: registering
 * that an incident happened to a vehicle, and — if the incident type's `disablesVehicle` is true —
 * moving that vehicle to `maintenance` immediately, in the same transaction. This is NOT RF-A17's
 * full maintenance workflow (list/schedule/complete a routine maintenance): only `create()` exists
 * here, on purpose — see vehicle_maintenances/DICTIONARY.md.
 */
@Injectable()
export class VehicleMaintenancesService {
    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        @InjectRepository(VehicleMaintenance)
        private readonly rawRepo: Repository<VehicleMaintenance>,
        private readonly vehiclesService: VehiclesService,
        private readonly vehicleIncidentTypesService: VehicleIncidentTypesService,
    ) {}

    async create(dto: CreateVehicleMaintenanceDto): Promise<VehicleMaintenanceDto> {
        const savedId = await this.dataSource.transaction(async (manager) => {
            const options = { manager };

            if (!(await this.vehiclesService.existsById(dto.vehicleId, options))) throw new VehicleNotFoundException();

            const disablesVehicle = await this.vehicleIncidentTypesService.getDisablesVehicle(dto.vehicleIncidentTypeId, options);
            if (disablesVehicle === null) throw new VehicleIncidentTypeNotFoundException();

            const repo = manager.getRepository(VehicleMaintenance);
            const maintenance             = repo.create();
            maintenance.vehicleId          = dto.vehicleId;
            maintenance.vehicleIncidentTypeId = dto.vehicleIncidentTypeId;
            maintenance.description         = dto.description;
            maintenance.status              = 'pending';

            const saved = await repo.save(maintenance);

            // RF-A34, Escenario 2 — same transaction as the insert above: either both writes land, or neither does.
            if (disablesVehicle) {
                await this.vehiclesService.setStatusByName(dto.vehicleId, VehicleStatusEnum.MAINTENANCE, options);
            }

            return saved.id;
        });

        const maintenance = await new DtoRepository(this.rawRepo).findOne({ dto: VehicleMaintenanceDto, where: { id: savedId } });
        const vehicle      = await this.vehiclesService.findOneById(VehicleDto, dto.vehicleId);

        return { ...maintenance!, vehicleStatus: vehicle.vehicleStatus.name };
    }
}
