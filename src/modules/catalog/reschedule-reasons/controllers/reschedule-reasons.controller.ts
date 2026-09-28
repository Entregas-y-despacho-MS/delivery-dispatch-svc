import {
    Controller, Get, Post, Put,
    Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation,
    ApiOkResponse, ApiCreatedResponse,
} from '@nestjs/swagger';
import { RescheduleReasonsService } from '../services/reschedule-reasons.service.js';
import { RescheduleReasonDto } from '../dto/reschedule-reason.dto.js';
import { CreateRescheduleReasonDto } from '../dto/create-reschedule-reason.dto.js';
import { UpdateRescheduleReasonDto } from '../dto/update-reschedule-reason.dto.js';
import { FindAllRescheduleReasonsParamsDto } from '../dto/find-all-reschedule-reasons-params.dto.js';
import { FindAllRescheduleReasonsResponseDto } from '../dto/find-all-reschedule-reasons-response.dto.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests, ApiIdParam, ApiConflict } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { RoleEnum, RescheduleReasonCategoryEnum } from '../../../../shared/enums/index.js';

/**
 * Error dictionary for this module:
 *   RESCHEDULE_REASON_NOT_FOUND             404 — No reschedule reason with the given ID exists or it was deleted.
 *   RESCHEDULE_REASON_CODE_ALREADY_EXISTS   409 — Another reschedule reason already has this name or this code.
 *   INVALID_TOKEN                           401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS                403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A33 — the catalog is managed by the dispatch coordinator and the operations supervisor
 * (root bypasses). Unlike incident-reasons, there is no external consumer (mobile app) reading
 * this catalog — it is only for the operations panel's reschedule/reassignment modal.
 */
@ApiTags('Reschedule Reasons')
@ApiBearerAuth('access-token')
@Controller('reschedule-reasons')
export class RescheduleReasonsController {
    constructor(private readonly rescheduleReasonsService: RescheduleReasonsService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'List reschedule reasons',
        description: 'Returns a paginated list (10 per page by default, up to 100) of the reschedule reasons that have not been deleted, ordered by name by default (`sortBy`/`sortOrder`; ties broken by id). `search` matches the code, the name or the description; `category` and `active` narrow the list and are kept when a search is also given. Requires coordinator or supervisor role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'sortBy' parameter must be one of: code, name, category, createdAt."] })
    @ApiOkResponse({ type: FindAllRescheduleReasonsResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllRescheduleReasonsParamsDto): Promise<PaginationResponseDto<RescheduleReasonDto>> {
        const result = await this.rescheduleReasonsService.findAll(RescheduleReasonDto, params);
        result.data.forEach((reason) => this.withAffectsSla(reason));
        return result;
    }

    @Get(':id')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Get a reschedule reason by ID',
        description: 'Returns a single reschedule reason by its numeric ID, whether it is enabled or disabled. A deleted reason is not found. Requires coordinator or supervisor role, or root.',
    })
    @ApiIdParam('Reschedule reason')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: RescheduleReasonDto })
    @ApiNotFound({ code: 'RESCHEDULE_REASON_NOT_FOUND', message: 'Reschedule reason not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<RescheduleReasonDto> {
        return this.withAffectsSla(await this.rescheduleReasonsService.findOneById(RescheduleReasonDto, id));
    }

    @Post()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Create a reschedule reason',
        description: 'Creates a reschedule reason with its `code`, its `name`, its `category` (client, operations or force_majeure — required, the coordinator must classify it explicitly) and an optional `description`. The new reason is always created enabled (`active: true`), so `active` is not accepted here. 409 when the code or the name is taken. Requires coordinator or supervisor role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Code is required.', 'Name is required.', 'Category must be one of: client, operations, force_majeure.'] })
    @ApiCreatedResponse({ type: RescheduleReasonDto })
    @ApiConflict({ code: 'RESCHEDULE_REASON_CODE_ALREADY_EXISTS', message: 'A reschedule reason with this name or code already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateRescheduleReasonDto): Promise<RescheduleReasonDto> {
        return this.withAffectsSla(await this.rescheduleReasonsService.create(RescheduleReasonDto, dto));
    }

    @Put(':id')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Update a reschedule reason',
        description: 'Partially updates a reschedule reason: only the fields sent are changed, and an empty body changes nothing. `null` is rejected on every field except `description`, where it (or an empty text) clears the value. If any field is invalid nothing is saved. `active: false` disables the reason (it stops being offered for new reschedules/reassignments, but ones already logged with it are not affected) and `active: true` enables it again; there is no delete endpoint for this catalog. 409 when a changed code or name is taken. Requires coordinator or supervisor role, or root.',
    })
    @ApiIdParam('Reschedule reason')
    @ApiBadRequests({ validation: true, id: true, example: ['Name must not be empty.'] })
    @ApiOkResponse({ type: RescheduleReasonDto })
    @ApiNotFound({ code: 'RESCHEDULE_REASON_NOT_FOUND', message: 'Reschedule reason not found.' })
    @ApiConflict({ code: 'RESCHEDULE_REASON_CODE_ALREADY_EXISTS', message: 'A reschedule reason with this name or code already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: UpdateRescheduleReasonDto,
    ): Promise<RescheduleReasonDto> {
        return this.withAffectsSla(await this.rescheduleReasonsService.update(RescheduleReasonDto, id, dto));
    }

    // `affectsSla` isn't a DB column — it's derived from `category` (RF-A33, Escenario 2) purely for
    // the API response, so the frontend doesn't have to duplicate "client means it doesn't count
    // against the punctuality metric" as its own hardcoded rule.
    private withAffectsSla(reason: RescheduleReasonDto): RescheduleReasonDto {
        reason.affectsSla = reason.category === RescheduleReasonCategoryEnum.CLIENT;
        return reason;
    }
}
