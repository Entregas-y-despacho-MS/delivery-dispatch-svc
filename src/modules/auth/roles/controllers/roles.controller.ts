import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { RolesService } from '../services/roles.service.js';
import { RoleDetailDto } from '../dto/role-detail.dto.js';
import { FindAllRolesParamsDto } from '../dto/find-all-roles-params.dto.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import type { AuthUser } from '../../../../app/auth/strategies/jwt.strategy.js';
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
        description: 'Returns the roles, paginated (10 per page by default, up to 100). Roles are a fixed catalog of 5 (root, admin, coordinator, supervisor, driver) that cannot be created, edited or deleted through the API; use a role\'s `id` as `roleId` when creating or updating a user, or to filter `GET /users`. Each role comes with `userCount` and `activeUserCount`. All filters are optional and combine with "and": `search` (name contains), `name` (exactly one role), and `assignable=true` (only the roles the caller may give to a user: no `root` unless the caller is root, which is what the user form\'s role selector needs). Sorted by `sortBy` / `sortOrder` (default: id, ascending). Requires admin or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'sortBy' parameter must be one of: id, name, createdAt."] })
    @ApiOkResponse({ type: FindAllRolesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllRolesParamsDto, @CurrentUser() actor: AuthUser): Promise<PaginationResponseDto<RoleDetailDto>> {
        return await this.rolesService.findAllWithUserCounts(params, actor.role);
    }

    @Get(':id')
    @Roles(RoleEnum.ADMIN, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Get a role by ID',
        description: 'Returns one role by ID, with its `userCount` and `activeUserCount`. Requires admin or coordinator role, or root.',
    })
    @ApiIdParam('Role')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: RoleDetailDto })
    @ApiNotFound({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<RoleDetailDto> {
        return await this.rolesService.findOneByIdWithUserCounts(id);
    }
}
