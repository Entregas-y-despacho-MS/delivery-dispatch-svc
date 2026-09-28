import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiCreatedResponse } from '@nestjs/swagger';
import { VehicleMaintenancesService } from '../services/vehicle-maintenances.service.js';
import { VehicleMaintenanceDto } from '../dto/vehicle-maintenance.dto.js';
import { CreateVehicleMaintenanceDto } from '../dto/create-vehicle-maintenance.dto.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';

/**
 * Error dictionary for this module:
 *   VEHICLE_NOT_FOUND                404 — No vehicle with the given `vehicleId` exists or it was removed.
 *   VEHICLE_INCIDENT_TYPE_NOT_FOUND   404 — No incident type with the given `vehicleIncidentTypeId` exists or it was deleted.
 *   INVALID_TOKEN                    401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS         403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A34, Escenario 2 — only the create endpoint exists here (see the service's own doc comment
 * for why); the fleet supervisor and the dispatch coordinator can register an incident (root bypasses).
 */
@ApiTags('Vehicle Maintenances')
@ApiBearerAuth('access-token')
@Controller('vehicle-maintenances')
export class VehicleMaintenancesController {
    constructor(private readonly vehicleMaintenancesService: VehicleMaintenancesService) {}

    @Post()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Register an incident on a vehicle',
        description: 'Registers that an incident of the given `vehicleIncidentTypeId` happened to `vehicleId` (RF-A34, Escenario 1). The record always starts in `pending` status. If that incident type\'s `disablesVehicle` is true, the vehicle is moved to `maintenance` in the same transaction (Escenario 2) — the response\'s `vehicleStatus` reflects it right away. Requires supervisor or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Description is required.'] })
    @ApiCreatedResponse({ type: VehicleMaintenanceDto })
    @ApiNotFound(
        { code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' },
        { code: 'VEHICLE_INCIDENT_TYPE_NOT_FOUND', message: 'Vehicle incident type not found.' },
    )
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateVehicleMaintenanceDto): Promise<VehicleMaintenanceDto> {
        return await this.vehicleMaintenancesService.create(dto);
    }
}
