import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { RolesService } from '../services/roles.service.js';
import { RoleDto } from '../dto/role.dto.js';
import { FindAllRolesParamsDto } from '../dto/find-all-roles-params.dto.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { FindAllRolesResponseDto } from '../dto/find-all-roles-response.dto.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests, ApiIdParam } from '../../../../shared/utils/swagger/index.js';

/**
 * Error dictionary for this module:
 *   ROLE_NOT_FOUND        404 — No role with the given ID exists.
 *   INVALID_TOKEN         401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS 403 — Authenticated but role does not meet the endpoint requirement.
 *
 * Read-only — roles are a fixed catalog, not administrable via the API. The coordinator can read it
 * too: the user list (RF-A28) needs it to fill the role filter.
 */
@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('roles')
export class RolesController {
    constructor(private readonly rolesService: RolesService) {}

    @Get()
    @Roles(RoleEnum.ADMIN, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'List roles',
        description: 'Returns the roles (root, admin, coordinator, supervisor, driver), paginated. `search` matches the name. Roles are a fixed catalog; use their `id` as `roleId` when creating users or filtering the user list. Requires admin or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'limit' parameter must be <= 100."] })
    @ApiOkResponse({ type: FindAllRolesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllRolesParamsDto): Promise<PaginationResponseDto<RoleDto>> {
        return await this.rolesService.findAll(RoleDto, params);
    }

    @Get(':id')
    @Roles(RoleEnum.ADMIN, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Get a role by ID',
        description: 'Returns one role by ID. Requires admin or coordinator role, or root.',
    })
    @ApiIdParam('Role')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: RoleDto })
    @ApiNotFound({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIntPipe) id: number): Promise<RoleDto> {
        return await this.rolesService.findOneById(RoleDto, id);
    }
}
