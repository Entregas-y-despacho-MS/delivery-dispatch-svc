import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import {
    ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized, ApiUnprocessableEntity,
} from '../../../../shared/utils/swagger/index.js';
import { AssignComplaintCaseDto, IssueComplaintVerdictDto, StartComplaintInvestigationDto } from '../dto/complaint-case-commands.dto.js';
import { ComplaintCaseDetailDto, FindComplaintCasesResponseDto } from '../dto/complaint-case.dto.js';
import { FindComplaintCasesParamsDto } from '../dto/find-complaint-cases-params.dto.js';
import { ComplaintCaseCommandsService } from '../services/complaint-case-commands.service.js';
import { ComplaintCasesService } from '../services/complaint-cases.service.js';

const STALE_VERSION = { code: 'COMPLAINT_CASE_VERSION_STALE', message: 'The case is at version 2 and the command was issued for version 1. Read the case again before acting on it.' };

/** What the three commands share: auth, the case lookup, the version and the eligibility of the dispatch. */
const ApiCaseCommand = (command: string, transitionExample: string, extraBadRequests: { code: string; message: string }[] = [], bodyExample: string[] = ['expectedVersion must be an integer.'], extraUnprocessable: { code: string; message: string }[] = []) =>
    applyDecorators(
        HttpCode(HttpStatus.OK),
        Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR),
        ApiIdParam('Complaint case'),
        ApiOkResponse({ type: ComplaintCaseDetailDto, description: `The case after \`${command}\` (or as it already was, when the command is repeated).` }),
        ApiBadRequests({ validation: true, id: true, errors: extraBadRequests, example: bodyExample }),
        ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' }),
        ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' }),
        ApiNotFound({ code: 'COMPLAINT_CASE_NOT_FOUND', message: 'Complaint case not found.' }),
        ApiConflict(STALE_VERSION, { code: 'INVALID_COMPLAINT_TRANSITION', message: transitionExample }),
        ApiUnprocessableEntity(
            { code: 'COMPLAINT_DISPATCH_NOT_DELIVERED', message: 'Only a case whose dispatch is delivered can be investigated.' },
            { code: 'COMPLAINT_REFERENCE_NOT_CORRELATED', message: 'The case does not match a delivery dispatch with the same tracking code, so it cannot be investigated.' },
            ...extraUnprocessable,
        ),
    );

/**
 * ST-45.2 (ES-45, RF-U22) — inbox of the complaints CRM opened about delivered dispatches, and the commands to
 * assign a case, start its investigation and issue the verdict.
 *
 * Error dictionary: VALIDATION_FAILED 400 (invalid filter, id, page or body) | INVALID_DATE_RANGE 400 (`from` after `to`) |
 * INVALID_COMPLAINT_ASSIGNEE 400 | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403 | COMPLAINT_CASE_NOT_FOUND 404 |
 * COMPLAINT_CASE_VERSION_STALE 409 | INVALID_COMPLAINT_TRANSITION 409 | COMPLAINT_DISPATCH_NOT_DELIVERED 422 |
 * COMPLAINT_REFERENCE_NOT_CORRELATED 422 | COMPLAINT_ORDER_REFERENCE_INVALID 422 (`verdict` only).
 */
@ApiTags('Complaint cases')
@ApiBearerAuth('access-token')
@Controller('complaint-cases')
export class ComplaintCasesController {
    constructor(
        private readonly cases: ComplaintCasesService,
        private readonly commands: ComplaintCaseCommandsService,
    ) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'List complaint cases',
        description: "Paginated inbox of the complaints CRM opened about delivered dispatches, most recently received first. Filters combine with AND: `from` and `to` (YYYY-MM-DD, both inclusive, Bolivia days, matched against the time the complaint was received), `zoneId` (delivery zone of the dispatch), `reasonCode`, `status` (`received`, `assigned`, `in_investigation`, `decided`) and `assignedUserId`. Each row carries `complaintId`, `crmCaseId`, `dispatchId`, `caseVersion`, its timestamps, the investigation status and the `nextAction` the person in charge can take. A case is listed and readable while its route batch is still `in_execution`: it only depends on its own dispatch being `delivered`. The answer has no customer data (name, phone, email, address) and no evidence URL. Requires coordinator or supervisor role, or root.",
    })
    @ApiOkResponse({ type: FindComplaintCasesResponseDto, description: 'One page of cases and its pagination metadata.' })
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
    @ApiOkResponse({ type: ComplaintCaseDetailDto, description: 'The case with its investigation.' })
    @ApiBadRequests({ id: true })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'COMPLAINT_CASE_NOT_FOUND', message: 'Complaint case not found.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<ComplaintCaseDetailDto> {
        return await this.cases.findOne(id);
    }

    @Post(':id/assign')
    @ApiCaseCommand(
        'assign', "The command 'assign' is not allowed while the case is 'decided'.",
        [{ code: 'INVALID_COMPLAINT_ASSIGNEE', message: 'The assignee must be an active coordinator or supervisor.' }],
    )
    @ApiOperation({
        summary:     'Take or assign a complaint case',
        description: "Puts a user in charge of a `received` case (or changes the person in charge of an `assigned` one): the case becomes `assigned` and stores who and when. `assigneeUserId` must be an active coordinator or supervisor; omitted, the person making the request takes the case. `expectedVersion` is the `caseVersion` that person read: a newer one from CRM is rejected with 409 and nothing changes. Repeating the same assignment changes nothing and answers 200. Only a case whose dispatch is `delivered` can be assigned, and the route batch does not matter. Requires coordinator or supervisor role, or root.",
    })
    async assign(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: AssignComplaintCaseDto,
        @CurrentUser('id') actorId: number,
    ): Promise<ComplaintCaseDetailDto> {
        return await this.commands.assign(id, dto, actorId);
    }

    @Post(':id/start-investigation')
    @ApiCaseCommand('start-investigation', "The command 'start_investigation' is not allowed while the case is 'received'.")
    @ApiOperation({
        summary:     'Start the investigation of a complaint case',
        description: "Moves an `assigned` case to `in_investigation` and stores when it started. The case must be assigned first. `expectedVersion` is the `caseVersion` the person read; a newer one is rejected with 409. Repeating it on a case already `in_investigation` changes nothing and answers 200. Only a case whose dispatch is `delivered` can be investigated. Requires coordinator or supervisor role, or root.",
    })
    async startInvestigation(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: StartComplaintInvestigationDto,
    ): Promise<ComplaintCaseDetailDto> {
        return await this.commands.startInvestigation(id, dto);
    }

    @Post(':id/verdict')
    @ApiCaseCommand(
        'verdict', "The command 'issue_verdict' is not allowed while the case is 'assigned'.", [],
        ['verdict must be one of: no_return_required, request_RMA, not_confirmed.', 'findings must not be empty.'],
        [{ code: 'COMPLAINT_ORDER_REFERENCE_INVALID', message: 'The order reference of the dispatch is longer than 64 characters, so the RMA authorization request cannot be sent to Inventory.' }],
    )
    @ApiOperation({
        summary:     'Issue the verdict of a complaint case',
        description: "Closes the investigation of an `in_investigation` case with one of three verdicts: `no_return_required`, `not_confirmed` or `request_RMA`. The reason (`decisionReason`) and the `findings` are required, plain text with no links; the case stores who decided and when. `request_RMA` leaves the case `decided` with `authorizationPending` true (authorization pending) and queues the authorization request to Inventory through the outbox in the same transaction; no pickup is created, because only Inventory approves or rejects. The other two verdicts request nothing. `expectedVersion` is the `caseVersion` the person read; a newer one is rejected with 409 and an old one never reverts a verdict already issued. Repeating the same verdict changes nothing and does not queue a second request. Dispatch never closes the commercial case, refunds or restocks. Requires coordinator or supervisor role, or root.",
    })
    async issueVerdict(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: IssueComplaintVerdictDto,
        @CurrentUser('id') actorId: number,
    ): Promise<ComplaintCaseDetailDto> {
        return await this.commands.issueVerdict(id, dto, actorId);
    }
}
