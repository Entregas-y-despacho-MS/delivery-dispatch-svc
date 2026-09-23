import {
    Controller, Get, Post, Put, Delete,
    Body, Param, Query, ParseIntPipe, HttpCode, HttpStatus,
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
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import {
    ApiNotFound, ApiUnauthorized, ApiValidationError, ApiConflict, ApiBadRequest,
} from '../../../../shared/utils/swagger/index.js';
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
        description: 'Returns a paginated list of vehicles, searchable by plate, model or type and filterable by status. Requires supervisor or coordinator role, or root.',
    })
    @ApiOkResponse({ type: FindAllVehiclesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllVehiclesParamsDto): Promise<PaginationResponseDto<VehicleDto>> {
        return await this.vehiclesService.findAll(VehicleDto, params);
    }

    @Get(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Get a vehicle by ID',
        description: 'Returns a single vehicle by its numeric ID. Requires supervisor or coordinator role, or root.',
    })
    @ApiOkResponse({ type: VehicleDto })
    @ApiNotFound({ code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIntPipe) id: number): Promise<VehicleDto> {
        return await this.vehiclesService.findOneById(VehicleDto, id);
    }

    @Post()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Register a vehicle',
        description: 'Registers a new vehicle with its plate, model, type and load capacities (kg and m3, both greater than zero). The plate must be unique. New vehicles start in the "active" status, ready for route assignment. Requires supervisor or coordinator role, or root.',
    })
    @ApiCreatedResponse({ type: VehicleDto })
    @ApiValidationError()
    @ApiConflict({ code: 'VEHICLE_PLATE_ALREADY_EXISTS', message: 'A vehicle with this plate already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateVehicleDto): Promise<VehicleDto> {
        return await this.vehiclesService.create(VehicleDto, dto);
    }

    @Put(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Update a vehicle',
        description: 'Partially updates a vehicle, including its operational status (vehicleStatusId). Only provided fields are changed. Requires supervisor or coordinator role, or root.',
    })
    @ApiOkResponse({ type: VehicleDto })
    @ApiValidationError()
    @ApiBadRequest({ code: 'INVALID_VEHICLE_STATUS', message: 'The given vehicle status does not exist.' })
    @ApiNotFound({ code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' })
    @ApiConflict({ code: 'VEHICLE_PLATE_ALREADY_EXISTS', message: 'A vehicle with this plate already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateVehicleDto,
    ): Promise<VehicleDto> {
        return await this.vehiclesService.update(VehicleDto, id, dto);
    }

    @Delete(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Remove a vehicle from the fleet',
        description: 'Soft-deletes the vehicle: historical dispatches and maintenances keep referencing it, but it stops appearing as an option and its plate can be reused. Requires supervisor or coordinator role, or root.',
    })
    @ApiNoContentResponse({ description: 'Vehicle removed.' })
    @ApiNotFound({ code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
        return await this.vehiclesService.remove(id);
    }
}
