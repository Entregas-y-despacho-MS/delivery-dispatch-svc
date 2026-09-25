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
import { ApiNotFound, ApiUnauthorized, ApiBadRequests, ApiIdParam, ApiConflict } from '../../../../shared/utils/swagger/index.js';
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
        description: 'Returns a paginated list (10 per page by default, up to 100) of the service levels that have not been deleted, ordered by the priority hierarchy: priority 1 first, then the tighter target time, then ID. The order is fixed. `search` matches the name or the description; `active` narrows to enabled or disabled levels, and it is kept when a search is also given. Requires coordinator role or root.',
    })
    @ApiOkResponse({ type: FindAllServiceLevelsResponseDto })
    @ApiBadRequests({ validation: true })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllServiceLevelsParamsDto): Promise<PaginationResponseDto<ServiceLevelDto>> {
        return await this.serviceLevelsService.findAll(ServiceLevelDto, params);
    }

    @Get(':id')
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Get a service level by ID',
        description: 'Returns a single service level by its numeric ID, whether it is enabled or disabled. A deleted level is not found. Requires coordinator role or root.',
    })
    @ApiIdParam('Service level')
    @ApiBadRequests({ id: true })
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
        description: 'Creates a service level with its target time (SLA: an integer number of minutes, from 15 to 43200) and its place in the priority hierarchy (1 = highest; levels may share a value). The name is required, is trimmed, and must not be used by another level. The description is optional. The new level is always created enabled (`active: true`), so `active` is not accepted here. 400 when a value is invalid (a target time under 15 minutes is rejected and nothing is saved); 409 when the name is taken. Requires coordinator role or root.',
    })
    @ApiCreatedResponse({ type: ServiceLevelDto })
    @ApiBadRequests({ validation: true })
    @ApiConflict({ code: 'SERVICE_LEVEL_NAME_ALREADY_EXISTS', message: 'A service level with this name already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateServiceLevelDto): Promise<ServiceLevelDto> {
        return await this.serviceLevelsService.create(ServiceLevelDto, dto);
    }

    @Put(':id')
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Update a service level',
        description: 'Partially updates a service level: only the fields sent are changed, and an empty body changes nothing. The same rules as on creation apply to each field; `null` is rejected on every field except `description`, where it (or an empty text) clears the value. If any field is invalid nothing is saved. `active: false` disables the level (it can no longer be assigned to new orders; dispatches already using it are not affected) and `active: true` enables it again — this is how a level with dispatches in progress is taken out of use, since it cannot be deleted. Requires coordinator role or root.',
    })
    @ApiIdParam('Service level')
    @ApiOkResponse({ type: ServiceLevelDto })
    @ApiBadRequests({ validation: true, id: true })
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
        description: 'Deletes the level (soft delete: dispatches that were already finished keep pointing at it, and its name can be reused afterwards). Rejected with 409 `SERVICE_LEVEL_IN_USE` while any dispatch that is pending or in transit still uses it — disable it instead with `PUT active: false`. Dispatches that are delivered, returned or not delivered do not block the deletion. Requires coordinator role or root.',
    })
    @ApiIdParam('Service level')
    @ApiBadRequests({ id: true })
    @ApiNoContentResponse({ description: 'Service level deleted.' })
    @ApiNotFound({ code: 'SERVICE_LEVEL_NOT_FOUND', message: 'Service level not found.' })
    @ApiConflict({ code: 'SERVICE_LEVEL_IN_USE', message: 'This service level has active dispatches and cannot be deleted. Disable it instead (active: false) so it only applies to future orders.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
        return await this.serviceLevelsService.remove(id);
    }
}
