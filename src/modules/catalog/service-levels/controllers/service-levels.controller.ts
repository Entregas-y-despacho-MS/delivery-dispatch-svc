import {
    Controller, Get, Post, Put, Delete,
    Body, Param, Query, ParseIntPipe, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation,
    ApiOkResponse, ApiCreatedResponse, ApiNoContentResponse,
} from '@nestjs/swagger';
import { ServiceLevelsService } from '../services/service-levels.service.js';
import { ServiceLevelDto } from '../dto/service-level.dto.js';
import { CreateServiceLevelDto } from '../dto/create-service-level.dto.js';
import { UpdateServiceLevelDto } from '../dto/update-service-level.dto.js';
import { FindAllServiceLevelsParamsDto } from '../dto/find-all-service-levels-params.dto.js';
import { FindAllServiceLevelsResponseDto } from '../dto/find-all-service-levels-response.dto.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { ApiNotFound, ApiUnauthorized, ApiValidationError, ApiConflict } from '../../../../shared/utils/swagger/index.js';
import { CoordinatorOnly } from '../../../../app/auth/decorators/index.js';

/**
 * Error dictionary for this module:
 *   SERVICE_LEVEL_NOT_FOUND             404 — No service level with the given ID exists or it was deleted.
 *   SERVICE_LEVEL_NAME_ALREADY_EXISTS   409 — Another active service level already has this name.
 *   SERVICE_LEVEL_IN_USE                409 — The level has dispatches in progress: disable it instead of deleting it.
 *   INVALID_TOKEN                       401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS            403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A31 — managed by the operations coordinator (@CoordinatorOnly(), root bypasses).
 */
@ApiTags('Service Levels')
@ApiBearerAuth('access-token')
@Controller('service-levels')
export class ServiceLevelsController {
    constructor(private readonly serviceLevelsService: ServiceLevelsService) {}

    @Get()
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'List service levels',
        description: 'Returns a paginated list ordered by the priority hierarchy (1 = highest first, then the tighter target time). Filterable by active and searchable by name or description. Requires coordinator role or root.',
    })
    @ApiOkResponse({ type: FindAllServiceLevelsResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllServiceLevelsParamsDto): Promise<PaginationResponseDto<ServiceLevelDto>> {
        return await this.serviceLevelsService.findAll(ServiceLevelDto, params);
    }

    @Get(':id')
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Get a service level by ID',
        description: 'Returns a single service level by its numeric ID. Requires coordinator role or root.',
    })
    @ApiOkResponse({ type: ServiceLevelDto })
    @ApiNotFound({ code: 'SERVICE_LEVEL_NOT_FOUND', message: 'Service level not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIntPipe) id: number): Promise<ServiceLevelDto> {
        return await this.serviceLevelsService.findOneById(ServiceLevelDto, id);
    }

    @Post()
    @CoordinatorOnly()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Create a service level',
        description: 'Creates a service level with its target time (SLA, an integer of at least 15 minutes) and its place in the priority hierarchy (1 = highest). The name must be unique. The new level is enabled. Requires coordinator role or root.',
    })
    @ApiCreatedResponse({ type: ServiceLevelDto })
    @ApiValidationError()
    @ApiConflict({ code: 'SERVICE_LEVEL_NAME_ALREADY_EXISTS', message: 'A service level with this name already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateServiceLevelDto): Promise<ServiceLevelDto> {
        return await this.serviceLevelsService.create(ServiceLevelDto, dto);
    }

    @Put(':id')
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Update a service level',
        description: 'Partially updates a service level, including disabling it (active: false), which only stops it from being assigned to new orders. Only provided fields are changed. Requires coordinator role or root.',
    })
    @ApiOkResponse({ type: ServiceLevelDto })
    @ApiValidationError()
    @ApiNotFound({ code: 'SERVICE_LEVEL_NOT_FOUND', message: 'Service level not found.' })
    @ApiConflict({ code: 'SERVICE_LEVEL_NAME_ALREADY_EXISTS', message: 'A service level with this name already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateServiceLevelDto,
    ): Promise<ServiceLevelDto> {
        return await this.serviceLevelsService.update(ServiceLevelDto, id, dto);
    }

    @Delete(':id')
    @CoordinatorOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Delete a service level',
        description: 'Soft-deletes the level. Rejected with 409 if dispatches in progress (pending or in transit) still use it — disable it instead with PUT active: false. Requires coordinator role or root.',
    })
    @ApiNoContentResponse({ description: 'Service level deleted.' })
    @ApiNotFound({ code: 'SERVICE_LEVEL_NOT_FOUND', message: 'Service level not found.' })
    @ApiConflict({ code: 'SERVICE_LEVEL_IN_USE', message: 'This service level has active dispatches and cannot be deleted. Disable it instead (active: false) so it only applies to future orders.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
        return await this.serviceLevelsService.remove(id);
    }
}
