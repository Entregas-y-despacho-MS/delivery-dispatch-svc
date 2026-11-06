import { Controller, Get, Post, Patch, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiCreatedResponse, ApiOkResponse, ApiResponse } from '@nestjs/swagger';
import { VehicleMaintenancesService } from '../services/vehicle-maintenances.service.js';
import { VehicleMaintenanceDto } from '../dto/vehicle-maintenance.dto.js';
import { CreateVehicleMaintenanceDto } from '../dto/create-vehicle-maintenance.dto.js';
import { ChangeMaintenanceStatusDto } from '../dto/change-maintenance-status.dto.js';
import { FindVehicleMaintenancesParamsDto } from '../dto/find-vehicle-maintenances-params.dto.js';
import { FindVehicleMaintenancesResponseDto } from '../dto/vehicle-maintenance-item.dto.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';

/**
 * Error dictionary for this module:
 *   VEHICLE_NOT_FOUND                404 — No vehicle with the given `vehicleId` exists or it was removed.
 *   VEHICLE_INCIDENT_TYPE_NOT_FOUND   404 — No incident type with the given `vehicleIncidentTypeId` exists or it was deleted.
 *   VEHICLE_MAINTENANCE_NOT_FOUND     404 — No maintenance with the given id.
 *   INVALID_MAINTENANCE_DATE_RANGE    400 — `from` is after `to`.
 *   INVALID_MAINTENANCE_TRANSITION    409 — Only pending → in_progress → completed is allowed.
 *   VEHICLE_HAS_ACTIVE_BATCHES        409 — The incident would put the vehicle in maintenance while it has confirmed or in-execution batches (ST-62.1 rule).
 *   INVALID_TOKEN                    401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS         403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A34 (register an incident) and RF-A17 (history, progress and closing of maintenances): the fleet
 * supervisor and the dispatch coordinator can use every endpoint (root bypasses).
 */
@ApiTags('Vehicle Maintenances')
@ApiBearerAuth('access-token')
@Controller('vehicle-maintenances')
export class VehicleMaintenancesController {
    constructor(private readonly vehicleMaintenancesService: VehicleMaintenancesService) {}

    @Get()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'List the maintenance history',
        description: 'Paginated history of vehicle maintenances (10 per page by default, up to 100), most recent first. Filters: `vehicleId`, `status`, and `from`/`to` (whole Bolivia days, inclusive, matched against the registration date). Each item carries the vehicle, the incident type and a derived `maintenanceType`: `corrective` when it comes from an incident type, `preventive` when it has none. Requires supervisor or coordinator role, or root.',
    })
    @ApiBadRequests({
        validation: true,
        errors: [{ code: 'INVALID_MAINTENANCE_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." }],
        example: ["The 'status' parameter must be one of: pending, in_progress, completed."],
    })
    @ApiOkResponse({ type: FindVehicleMaintenancesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission.' })
    async findAll(@Query() params: FindVehicleMaintenancesParamsDto): Promise<FindVehicleMaintenancesResponseDto> {
        return await this.vehicleMaintenancesService.findAll(params);
    }

    @Post()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Register an incident on a vehicle',
        description: 'Registers that an incident of the given `vehicleIncidentTypeId` happened to `vehicleId` (RF-A34, Escenario 1). The record always starts in `pending` status. If that incident type\'s `disablesVehicle` is true, the vehicle is moved to `maintenance` in the same transaction (Escenario 2) — the response\'s `vehicleStatus` reflects it right away — unless it has a `confirmed` or `in_execution` route batch: then nothing is saved and the answer is 409 with the affected batches. Requires supervisor or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Description is required.'] })
    @ApiCreatedResponse({ type: VehicleMaintenanceDto })
    @ApiNotFound(
        { code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' },
        { code: 'VEHICLE_INCIDENT_TYPE_NOT_FOUND', message: 'Vehicle incident type not found.' },
    )
    @ApiResponse({
        status: 409,
        description: 'The vehicle cannot go to `maintenance` while it has confirmed or in-execution route batches. `details.batches` has their IDs and shift dates.',
        schema: {
            example: {
                statusCode: 409,
                error: 'VEHICLE_HAS_ACTIVE_BATCHES',
                message: 'The vehicle cannot be moved to this status while it has confirmed or in-execution route batches.',
                details: { batches: [{ id: 42, shiftDate: '2026-11-06' }] },
                path: '/api/vehicle-maintenances',
                timestamp: '2026-11-05T12:00:00.000Z',
            },
        },
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission.' })
    async create(@Body() dto: CreateVehicleMaintenanceDto): Promise<VehicleMaintenanceDto> {
        return await this.vehicleMaintenancesService.create(dto);
    }

    @Patch(':id/status')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Advance a maintenance',
        description: 'Moves a maintenance forward: `pending` → `in_progress` → `completed`; any other move is 409. Completing sets `completedAt` and, in the same transaction, returns the vehicle to `active` if it is in `maintenance` and has no other open (pending or in_progress) maintenance. Requires supervisor or coordinator role, or root.',
    })
    @ApiIdParam('Vehicle maintenance')
    @ApiBadRequests({ validation: true, id: true, example: ['Status must be pending, in_progress, or completed.'] })
    @ApiOkResponse({ type: VehicleMaintenanceDto })
    @ApiNotFound({ code: 'VEHICLE_MAINTENANCE_NOT_FOUND', message: 'Vehicle maintenance not found.' })
    @ApiConflict({ code: 'INVALID_MAINTENANCE_TRANSITION', message: 'A maintenance cannot go from pending to completed. Allowed: pending -> in_progress -> completed.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission.' })
    async changeStatus(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: ChangeMaintenanceStatusDto,
    ): Promise<VehicleMaintenanceDto> {
        return await this.vehicleMaintenancesService.changeStatus(id, dto);
    }
}
