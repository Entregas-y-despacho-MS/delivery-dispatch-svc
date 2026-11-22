import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { ApiBadRequests, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';
import { ComplaintCaseDetailDto, FindComplaintCasesResponseDto } from '../dto/complaint-case.dto.js';
import { FindComplaintCasesParamsDto } from '../dto/find-complaint-cases-params.dto.js';
import { ComplaintCasesService } from '../services/complaint-cases.service.js';

/**
 * ST-45.2 (ES-45, RF-U22) — inbox of the complaints CRM opened about delivered dispatches.
 *
 * Error dictionary: VALIDATION_FAILED 400 (invalid filter, id or page) | INVALID_DATE_RANGE 400 (`from` after `to`) |
 * INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403 | COMPLAINT_CASE_NOT_FOUND 404.
 */
@ApiTags('Complaint cases')
@ApiBearerAuth('access-token')
@Controller('complaint-cases')
export class ComplaintCasesController {
    constructor(private readonly cases: ComplaintCasesService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'List complaint cases',
        description: "Paginated inbox of the complaints CRM opened about delivered dispatches, most recently received first. Filters combine with AND: `from` and `to` (YYYY-MM-DD, both inclusive, Bolivia days, matched against the time the complaint was received), `zoneId` (delivery zone of the dispatch), `reasonCode`, `status` (`received`, `assigned`, `in_investigation`, `decided`) and `assignedUserId`. Each row carries `complaintId`, `crmCaseId`, `dispatchId`, `caseVersion`, its timestamps, the investigation status and the `nextAction` the person in charge can take. A case is listed and readable while its route batch is still `in_execution`: it only depends on its own dispatch being `delivered`. The answer has no customer data (name, phone, email, address) and no evidence URL. Requires coordinator or supervisor role, or root.",
    })
    @ApiOkResponse({ type: FindComplaintCasesResponseDto })
    @ApiBadRequests({
        validation: true,
        errors: [{ code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." }],
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'status' parameter must be one of: received, assigned, in_investigation, decided."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findAll(@Query() params: FindComplaintCasesParamsDto): Promise<FindComplaintCasesResponseDto> {
        return await this.cases.findAll(params);
    }

    @Get(':id')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Get a complaint case',
        description: "The case with its investigation: findings, verdict and its reason, who took it and who decided it (and when), the RMA references (`authorizationRequestId`, `rmaId`), the affected items and the route batch of the dispatch. A `request_RMA` verdict without `rmaId` is `authorizationPending`: only Inventory approves or rejects it. No customer data and no evidence URL. Requires coordinator or supervisor role, or root.",
    })
    @ApiIdParam('Complaint case')
    @ApiOkResponse({ type: ComplaintCaseDetailDto })
    @ApiBadRequests({ id: true })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'COMPLAINT_CASE_NOT_FOUND', message: 'Complaint case not found.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<ComplaintCaseDetailDto> {
        return await this.cases.findOne(id);
    }
}
