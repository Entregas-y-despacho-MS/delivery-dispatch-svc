import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { RolesService } from '../services/roles.service.js';
import { RoleDto } from '../dto/role.dto.js';
import { FindAllRolesParamsDto } from '../dto/find-all-roles-params.dto.js';
import { PaginationResponseDto } from '../../../shared/dto/index.js';
import { AdminOnly } from '../../../app/auth/decorators/index.js';
import { ApiNotFound, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';

/**
 * Error dictionary for this module:
 *   ROLE_NOT_FOUND        404 — No role with the given ID exists.
 *   INVALID_TOKEN         401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS 403 — Authenticated but role does not meet the endpoint requirement.
 *
 * Read-only — roles are a fixed catalog, not administrable via the API.
 */
@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('roles')
export class RolesController {
    constructor(private readonly rolesService: RolesService) {}

    @Get()
    @AdminOnly()
    @ApiOperation({
        summary:     'List roles',
        description: 'Returns a paginated list of roles, searchable by name. Requires admin role or root.',
    })
    @ApiOkResponse({ type: PaginationResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllRolesParamsDto): Promise<PaginationResponseDto<RoleDto>> {
        return await this.rolesService.findAll(RoleDto, params);
    }

    @Get(':id')
    @AdminOnly()
    @ApiOperation({
        summary:     'Get a role by ID',
        description: 'Returns a single role by its numeric ID. Requires admin role or root.',
    })
    @ApiOkResponse({ type: RoleDto })
    @ApiNotFound({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIntPipe) id: number): Promise<RoleDto> {
        return await this.rolesService.findOneById(RoleDto, id);
    }
}
