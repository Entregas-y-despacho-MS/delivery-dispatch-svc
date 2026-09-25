import {
    Controller, Get, Post, Put, Delete,
    Body, Param, Query, ParseIntPipe, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation,
    ApiOkResponse, ApiCreatedResponse, ApiNoContentResponse,
} from '@nestjs/swagger';
import { UsersService } from '../services/users.service.js';
import { UserDto } from '../dto/user.dto.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
import { FindAllUsersParamsDto } from '../dto/find-all-users-params.dto.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { ApiNotFound, ApiUnauthorized, ApiConflict, ApiBadRequests, ApiIdParam } from '../../../../shared/utils/swagger/index.js';
import { FindAllUsersResponseDto } from '../dto/find-all-users-response.dto.js';
import { AdminOnly, Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';

/**
 * Error dictionary for this module:
 *   USER_NOT_FOUND        404 — No user with the given ID exists or it was soft-deleted.
 *   USER_ALREADY_EXISTS   409 — A user with the given username or email already exists.
 *   PASSWORD_TOO_SHORT    400 — Password is shorter than settings.password_min_length.
 *   INVALID_ROLE          400 — The given roleId does not exist.
 *   CONFLICTING_USER_FILTERS 400 — The list was asked with both `active` and `status`.
 *   INVALID_TOKEN         401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS 403 — Authenticated but role does not meet the endpoint requirement.
 *
 * Internal user management — this is an admin-managed system, every endpoint here requires
 * @AdminOnly() (root bypasses via RolesGuard as usual), except the list, which the coordinator also
 * uses (RF-A28).
 */
@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    // RF-A28 — the list is also for the logistics coordinator (audit / find available operators);
    // everything else in this controller stays admin-only.
    @Get()
    @Roles(RoleEnum.ADMIN, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'List users',
        description: 'Returns a paginated list of users (10 per page by default, up to 100), newest first unless `sortBy`/`sortOrder` say otherwise. All filters are optional and combine with "and": `roleId` (see GET /roles), `status` (active | inactive | locked) or `active` (true/false; do not send both, that is a 400 CONFLICTING_USER_FILTERS), and `search` over full name, username and email. Each user carries its derived `status` and last login date. Requires admin or coordinator role, or root.',
    })
    @ApiBadRequests({ validation: true, errors: [{ code: 'CONFLICTING_USER_FILTERS', message: "Use either the 'active' or the 'status' filter, not both." }] })
    @ApiOkResponse({ type: FindAllUsersResponseDto })
    @ApiUnauthorized(
        { code: 'INVALID_TOKEN',   message: 'Invalid or expired token.' },
    )
    async findAll(@Query() params: FindAllUsersParamsDto): Promise<PaginationResponseDto<UserDto>> {
        return await this.usersService.findAll(UserDto, params);
    }

    @Get(':id')
    @AdminOnly()
    @ApiOperation({
        summary:     'Get a user by ID',
        description: 'Returns one user by ID, including its role, derived status, 2FA flag and last login. A deleted user is not found. Requires admin role or root.',
    })
    @ApiIdParam('User')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: UserDto })
    @ApiNotFound({ code: 'USER_NOT_FOUND', message: 'User not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIntPipe) id: number): Promise<UserDto> {
        return await this.usersService.findOneById(UserDto, id);
    }

    @Post()
    @AdminOnly()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Create a user',
        description: 'Creates an internal user account. `fullName`, `username`, `password` and `roleId` are required; `email` is optional. `username` (and `email`, if given) must not belong to another user (409 USER_ALREADY_EXISTS). The password must be at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol, and at least the length configured in settings (`password_min_length`, 400 PASSWORD_TOO_SHORT). The account is created active, and the user is asked to change the password at first login. Requires admin role or root.',
    })
    @ApiBadRequests({ validation: true, errors: [{ code: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters.' }, { code: 'INVALID_ROLE', message: 'The given role does not exist.' }] })
    @ApiCreatedResponse({ type: UserDto })
    @ApiConflict({ code: 'USER_ALREADY_EXISTS', message: 'A user with this username or email already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateUserDto): Promise<UserDto> {
        return await this.usersService.create(UserDto, dto);
    }

    @Put(':id')
    @AdminOnly()
    @ApiOperation({
        summary:     'Update a user',
        description: 'Partially updates a user: only the fields sent are changed. `email` can be cleared by sending `null`; every other field rejects `null`. `active: false` deactivates the account (the user can no longer log in) and `true` reactivates it. A new `password` resets the user\'s password (admin action: the password history is not checked, and the user\'s own sessions are not closed). A changed `username` or `email` must not belong to another user (409), and a new `roleId` must exist (400 INVALID_ROLE). Requires admin role or root.',
    })
    @ApiIdParam('User')
    @ApiBadRequests({ validation: true, id: true, errors: [{ code: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters.' }, { code: 'INVALID_ROLE', message: 'The given role does not exist.' }] })
    @ApiOkResponse({ type: UserDto })
    @ApiNotFound({ code: 'USER_NOT_FOUND', message: 'User not found.' })
    @ApiConflict({ code: 'USER_ALREADY_EXISTS', message: 'A user with this username or email already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateUserDto,
    ): Promise<UserDto> {
        return await this.usersService.update(UserDto, id, dto);
    }

    @Delete(':id')
    @AdminOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Delete a user',
        description: 'Soft-deletes the user: the record stays in the database but no longer appears in lists or lookups. To only block access, deactivate the user instead (PUT `active: false`). Requires admin role or root.',
    })
    @ApiIdParam('User')
    @ApiBadRequests({ id: true })
    @ApiNoContentResponse({ description: 'User deleted successfully.' })
    @ApiNotFound({ code: 'USER_NOT_FOUND', message: 'User not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
        return await this.usersService.remove(id);
    }
}
