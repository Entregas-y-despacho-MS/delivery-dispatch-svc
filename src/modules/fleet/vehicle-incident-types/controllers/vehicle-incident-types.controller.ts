import {
    Controller, Get, Post, Put,
    Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation,
    ApiOkResponse, ApiCreatedResponse,
} from '@nestjs/swagger';
import { VehicleIncidentTypesService } from '../services/vehicle-incident-types.service.js';
import { VehicleIncidentTypeDto } from '../dto/vehicle-incident-type.dto.js';
import { CreateVehicleIncidentTypeDto } from '../dto/create-vehicle-incident-type.dto.js';
import { UpdateVehicleIncidentTypeDto } from '../dto/update-vehicle-incident-type.dto.js';
import { FindAllVehicleIncidentTypesParamsDto } from '../dto/find-all-vehicle-incident-types-params.dto.js';
import { FindAllVehicleIncidentTypesResponseDto } from '../dto/find-all-vehicle-incident-types-response.dto.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests, ApiIdParam, ApiConflict } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';

/**
 * Error dictionary for this module:
 *   VEHICLE_INCIDENT_TYPE_NOT_FOUND             404 — No incident type with the given ID exists or it was deleted.
 *   VEHICLE_INCIDENT_TYPE_CODE_ALREADY_EXISTS   409 — Another incident type already has this name or this code.
 *   INVALID_TOKEN                               401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS                    403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A34 — the catalog is managed by the fleet supervisor and the dispatch coordinator (root
 * bypasses) — same pairing as /vehicles.
 */
@ApiTags('Vehicle Incident Types')
@ApiBearerAuth('access-token')
@Controller('vehicle-incident-types')
export class VehicleIncidentTypesController {
    constructor(private readonly vehicleIncidentTypesService: VehicleIncidentTypesService) {}

    @Get()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'List vehicle incident types',
        description: 'Returns a paginated list (10 per page by default, up to 100) of the vehicle incident types that have not been deleted, ordered by name by default (`sortBy`/`sortOrder`; ties broken by id). `search` matches the code or the name; `severity` and `disablesVehicle` narrow the list and are kept when a search is also given. Requires supervisor or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'sortBy' parameter must be one of: code, name, severity, createdAt."] })
    @ApiOkResponse({ type: FindAllVehicleIncidentTypesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllVehicleIncidentTypesParamsDto): Promise<PaginationResponseDto<VehicleIncidentTypeDto>> {
        return await this.vehicleIncidentTypesService.findAll(VehicleIncidentTypeDto, params);
    }

    @Get(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Get a vehicle incident type by ID',
        description: 'Returns a single vehicle incident type by its numeric ID. A deleted type is not found. Requires supervisor or coordinator role, or root.',
    })
    @ApiIdParam('Vehicle incident type')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: VehicleIncidentTypeDto })
    @ApiNotFound({ code: 'VEHICLE_INCIDENT_TYPE_NOT_FOUND', message: 'Vehicle incident type not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<VehicleIncidentTypeDto> {
        return await this.vehicleIncidentTypesService.findOneById(VehicleIncidentTypeDto, id);
    }

    @Post()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Create a vehicle incident type',
        description: 'Creates a vehicle incident type with its `code`, its `name`, its `severity` (minor, moderate or critical — required, the supervisor must classify it explicitly) and `disablesVehicle` (required, whether registering an incident of this type immediately sets the vehicle to `maintenance` — RF-A34, Escenario 2). 409 when the code or the name is taken. Requires supervisor or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Code is required.', 'Name is required.', 'Severity must be one of: minor, moderate, critical.', 'Disables vehicle must be true or false.'] })
    @ApiCreatedResponse({ type: VehicleIncidentTypeDto })
    @ApiConflict({ code: 'VEHICLE_INCIDENT_TYPE_CODE_ALREADY_EXISTS', message: 'A vehicle incident type with this name or code already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateVehicleIncidentTypeDto): Promise<VehicleIncidentTypeDto> {
        return await this.vehicleIncidentTypesService.create(VehicleIncidentTypeDto, dto);
    }

    @Put(':id')
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Update a vehicle incident type',
        description: 'Partially updates a vehicle incident type: only the fields sent are changed, and an empty body changes nothing. `null` is rejected on every field. If any field is invalid nothing is saved. There is no delete endpoint for this catalog. 409 when a changed code or name is taken. Requires supervisor or coordinator role, or root.',
    })
    @ApiIdParam('Vehicle incident type')
    @ApiBadRequests({ validation: true, id: true, example: ['Severity must be one of: minor, moderate, critical.'] })
    @ApiOkResponse({ type: VehicleIncidentTypeDto })
    @ApiNotFound({ code: 'VEHICLE_INCIDENT_TYPE_NOT_FOUND', message: 'Vehicle incident type not found.' })
    @ApiConflict({ code: 'VEHICLE_INCIDENT_TYPE_CODE_ALREADY_EXISTS', message: 'A vehicle incident type with this name or code already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: UpdateVehicleIncidentTypeDto,
    ): Promise<VehicleIncidentTypeDto> {
        return await this.vehicleIncidentTypesService.update(VehicleIncidentTypeDto, id, dto);
    }
}
