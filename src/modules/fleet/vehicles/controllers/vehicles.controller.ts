import {
    Controller, Get, Post, Put, Delete,
    Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation,
    ApiOkResponse, ApiCreatedResponse, ApiNoContentResponse,
} from '@nestjs/swagger';
import { VehiclesService } from '../services/vehicles.service.js';
import { VehicleDto } from '../dto/vehicle.dto.js';
import { CreateVehicleDto } from '../dto/create-vehicle.dto.js';
import { UpdateVehicleDto } from '../dto/update-vehicle.dto.js';
import { FindAllVehiclesParamsDto } from '../dto/find-all-vehicles-params.dto.js';
import { FindAllVehiclesResponseDto } from '../dto/find-all-vehicles-response.dto.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ApiNotFound, ApiUnauthorized, ApiConflict, ApiBadRequests, ApiIdParam } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';

/**
 * Error dictionary for this module:
 *   VEHICLE_NOT_FOUND            404 — No vehicle with the given ID exists or it was soft-deleted.
 *   VEHICLE_PLATE_ALREADY_EXISTS 409 — Another active vehicle already has this plate.
 *   INVALID_VEHICLE_STATUS       400 — The given vehicleStatusId does not exist.
 *   INVALID_TOKEN                401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS     403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A30 — fleet is managed by the fleet supervisor and the dispatch coordinator (root bypasses).
 */
@ApiTags('Vehicles')
@ApiBearerAuth('access-token')
@Controller('vehicles')
export class VehiclesController {
    constructor(private readonly vehiclesService: VehiclesService) {}

    @Get()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'List vehicles',
        description: 'Returns a paginated list of vehicles (10 per page by default, up to 100). `search` matches the plate, model or type (case-insensitive); `vehicleStatusId` keeps only vehicles in that operational status (1 = active, 2 = maintenance, 3 = out_of_service). Requires supervisor or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'limit' parameter must be <= 100."] })
    @ApiOkResponse({ type: FindAllVehiclesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllVehiclesParamsDto): Promise<PaginationResponseDto<VehicleDto>> {
        return await this.vehiclesService.findAll(VehicleDto, params);
    }

    @Get(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Get a vehicle by ID',
        description: 'Returns one vehicle by ID, with its operational status. A removed vehicle is not found. Requires supervisor or coordinator role, or root.',
    })
    @ApiIdParam('Vehicle')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: VehicleDto })
    @ApiNotFound({ code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<VehicleDto> {
        return await this.vehiclesService.findOneById(VehicleDto, id);
    }

    @Post()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Register a vehicle',
        description: 'Registers a vehicle. All five fields are required: `type`, `model`, `plate`, `capacityKg` and `capacityM3` (both greater than zero, up to 2 decimals). The plate is trimmed and uppercased, and must not belong to another vehicle (409 VEHICLE_PLATE_ALREADY_EXISTS). The vehicle starts in the `active` status, ready for route assignment. Requires supervisor or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Plate is required.', 'Capacity in kg must be greater than zero.'] })
    @ApiCreatedResponse({ type: VehicleDto })
    @ApiConflict({ code: 'VEHICLE_PLATE_ALREADY_EXISTS', message: 'A vehicle with this plate already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateVehicleDto): Promise<VehicleDto> {
        return await this.vehiclesService.create(VehicleDto, dto);
    }

    @Put(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Update a vehicle',
        description: 'Partially updates a vehicle: only the fields sent are changed, and `null` is rejected. This is also how the operational status is changed (`vehicleStatusId`: 1 = active, 2 = maintenance, 3 = out_of_service; an unknown ID is a 400 INVALID_VEHICLE_STATUS). A changed plate must not belong to another vehicle (409). Requires supervisor or coordinator role, or root.',
    })
    @ApiIdParam('Vehicle')
    @ApiBadRequests({ validation: true, example: ['Capacity in m3 must be greater than zero.'], id: true, errors: [{ code: 'INVALID_VEHICLE_STATUS', message: 'The given vehicle status does not exist.' }] })
    @ApiOkResponse({ type: VehicleDto })
    @ApiNotFound({ code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' })
    @ApiConflict({ code: 'VEHICLE_PLATE_ALREADY_EXISTS', message: 'A vehicle with this plate already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: UpdateVehicleDto,
    ): Promise<VehicleDto> {
        return await this.vehiclesService.update(VehicleDto, id, dto);
    }

    @Delete(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Remove a vehicle from the fleet',
        description: 'Soft-deletes the vehicle: historical dispatches and maintenances keep referencing it, but it stops appearing in lists and its plate can be reused. To only take it out of service temporarily, change its status instead (PUT `vehicleStatusId`). Requires supervisor or coordinator role, or root.',
    })
    @ApiIdParam('Vehicle')
    @ApiBadRequests({ id: true })
    @ApiNoContentResponse({ description: 'Vehicle removed.' })
    @ApiNotFound({ code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async remove(@Param('id', ParseIdPipe) id: number): Promise<void> {
        return await this.vehiclesService.remove(id);
    }
}
