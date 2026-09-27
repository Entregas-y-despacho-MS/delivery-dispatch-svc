import {
    Controller, Get, Post, Put,
    Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation,
    ApiOkResponse, ApiCreatedResponse,
} from '@nestjs/swagger';
import { IncidentReasonsService } from '../services/incident-reasons.service.js';
import { IncidentReasonDto } from '../dto/incident-reason.dto.js';
import { CreateIncidentReasonDto } from '../dto/create-incident-reason.dto.js';
import { UpdateIncidentReasonDto } from '../dto/update-incident-reason.dto.js';
import { FindAllIncidentReasonsParamsDto } from '../dto/find-all-incident-reasons-params.dto.js';
import { FindAllIncidentReasonsResponseDto } from '../dto/find-all-incident-reasons-response.dto.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests, ApiIdParam, ApiConflict } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';

/**
 * Error dictionary for this module:
 *   INCIDENT_REASON_NOT_FOUND           404 — No incident reason with the given ID exists or it was deleted.
 *   INCIDENT_REASON_CODE_ALREADY_EXISTS 409 — Another incident reason already has this code.
 *   INVALID_TOKEN                       401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS            403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A32 — the catalog is managed by the logistics coordinator and the operations supervisor
 * (root bypasses). The list/get endpoints are also open to the driver: the mobile app fetches
 * this catalog to let the driver pick a reason and cache it for offline use.
 */
@ApiTags('Incident Reasons')
@ApiBearerAuth('access-token')
@Controller('incident-reasons')
export class IncidentReasonsController {
    constructor(private readonly incidentReasonsService: IncidentReasonsService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR, RoleEnum.DRIVER)
    @ApiOperation({
        summary:     'List incident reasons',
        description: 'Returns a paginated list (10 per page by default, up to 100) of the incident reasons that have not been deleted, ordered by name by default (`sortBy`/`sortOrder`; ties broken by id). `search` matches the name or the code; `active` and `requiresEvidence` narrow the list and are kept when a search is also given. The driver\'s mobile app uses this (with `active=true&limit=100`) to download and cache the whole catalog offline for RF-U06. Requires coordinator, supervisor or driver role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'sortBy' parameter must be one of: name, code, createdAt."] })
    @ApiOkResponse({ type: FindAllIncidentReasonsResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllIncidentReasonsParamsDto): Promise<PaginationResponseDto<IncidentReasonDto>> {
        return await this.incidentReasonsService.findAll(IncidentReasonDto, params);
    }

    @Get(':id')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR, RoleEnum.DRIVER)
    @ApiOperation({
        summary:     'Get an incident reason by ID',
        description: 'Returns a single incident reason by its numeric ID, whether it is enabled or disabled. A deleted reason is not found. Requires coordinator, supervisor or driver role, or root.',
    })
    @ApiIdParam('Incident reason')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: IncidentReasonDto })
    @ApiNotFound({ code: 'INCIDENT_REASON_NOT_FOUND', message: 'Incident reason not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<IncidentReasonDto> {
        return await this.incidentReasonsService.findOneById(IncidentReasonDto, id);
    }

    @Post()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Create an incident reason',
        description: 'Creates an incident reason with its unique `code`, its display `name`, and whether it `requiresEvidence` (a photo) — all three are required. The code is trimmed and uppercased. The new reason is always created enabled (`active: true`), so `active` is not accepted here. 409 when the code is taken. Requires coordinator or supervisor role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Code is required.', 'Name is required.', 'Requires evidence must be true or false.'] })
    @ApiCreatedResponse({ type: IncidentReasonDto })
    @ApiConflict({ code: 'INCIDENT_REASON_CODE_ALREADY_EXISTS', message: 'An incident reason with this code already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateIncidentReasonDto): Promise<IncidentReasonDto> {
        return await this.incidentReasonsService.create(IncidentReasonDto, dto);
    }

    @Put(':id')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Update an incident reason',
        description: 'Partially updates an incident reason: only the fields sent are changed, and an empty body changes nothing. `null` is rejected on every field. If any field is invalid nothing is saved. `active: false` disables the reason (RF-A32, Escenario 2 — it stops being offered for new incidents, but incidents already logged with it, and their evidence, are not affected) and `active: true` enables it again; there is no delete endpoint for this catalog. 409 when a changed code is taken. Requires coordinator or supervisor role, or root.',
    })
    @ApiIdParam('Incident reason')
    @ApiBadRequests({ validation: true, id: true, example: ['Code must not be empty.'] })
    @ApiOkResponse({ type: IncidentReasonDto })
    @ApiNotFound({ code: 'INCIDENT_REASON_NOT_FOUND', message: 'Incident reason not found.' })
    @ApiConflict({ code: 'INCIDENT_REASON_CODE_ALREADY_EXISTS', message: 'An incident reason with this code already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: UpdateIncidentReasonDto,
    ): Promise<IncidentReasonDto> {
        return await this.incidentReasonsService.update(IncidentReasonDto, id, dto);
    }
}
