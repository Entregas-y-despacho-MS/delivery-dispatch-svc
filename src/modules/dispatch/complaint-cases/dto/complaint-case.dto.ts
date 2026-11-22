import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { COMPLAINT_NEXT_ACTIONS, type ComplaintNextAction } from '../utils/next-action.js';
import { COMPLAINT_INVESTIGATION_STATUSES } from './find-complaint-cases-params.dto.js';

/**
 * A complaint case as the inbox lists it. It carries no customer data (no name, phone, email, address) and no
 * evidence URL: only identifiers, state, dates and the operative facts of the dispatch.
 */
export class ComplaintCaseItemDto {
    @ApiProperty({ type: 'integer', example: 12, description: 'Complaint case ID (`complaintId`); the path parameter of the case endpoints' })
    complaintId!: number;

    @ApiProperty({ type: String, example: 'CRM-2026-00031', description: 'Case ID in the CRM that opened the complaint' })
    crmCaseId!: string;

    @ApiProperty({ type: 'integer', example: 245, description: 'Dispatch the complaint refers to (the one that was delivered)' })
    dispatchId!: number;

    @ApiProperty({ type: String, nullable: true, example: 'DSP-2026-00245', description: 'Tracking code of the dispatch. null if it has none' })
    trackingCode!: string | null;

    @ApiProperty({ type: 'integer', example: 1, description: 'Version of the case, as CRM last sent it. Commands must send the version they read; an older one is rejected with 409' })
    caseVersion!: number;

    @ApiProperty({ type: String, example: 'DAMAGED_ITEM', description: 'Reason code of the complaint, as CRM sent it' })
    reasonCode!: string;

    @ApiProperty({ enum: COMPLAINT_INVESTIGATION_STATUSES, example: 'received', description: 'Investigation status: `received` → `assigned` → `in_investigation` → `decided`' })
    investigationStatus!: string;

    @ApiProperty({ enum: COMPLAINT_NEXT_ACTIONS, example: 'assign', description: 'What the person in charge can do next. `await_inventory_authorization`: a `request_RMA` verdict waiting for Inventory (RMA authorization pending). `none`: nothing left to do here, or the dispatch is not `delivered`' })
    nextAction!: ComplaintNextAction;

    @ApiProperty({ type: Boolean, example: true, description: 'true when the dispatch is `delivered`, the only state a case can be investigated for. It does not depend on the route batch being closed' })
    eligible!: boolean;

    @ApiProperty({ type: String, example: 'delivered', description: 'Current status of the dispatch' })
    dispatchStatus!: string;

    @ApiProperty({ type: 'integer', nullable: true, example: 3, description: 'Delivery zone of the dispatch. null if it has none' })
    zoneId!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Zona Sur', description: 'Name of the delivery zone. null if the dispatch has none' })
    zoneName!: string | null;

    @ApiProperty({ type: 'integer', nullable: true, example: 7, description: 'User in charge of the case. null while it is `received`' })
    assignedUserId!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Ana Rojas', description: 'Full name of the user in charge. null while the case is `received`' })
    assignedUserName!: string | null;

    @ApiProperty({ type: String, nullable: true, enum: ['no_return_required', 'request_RMA', 'not_confirmed'], description: 'Verdict of the investigation. null until the case is `decided`' })
    verdict!: string | null;

    @ApiProperty({ type: Boolean, example: false, description: 'true when the verdict is `request_RMA` and Inventory has not approved or rejected it yet (`authorization_pending`)' })
    authorizationPending!: boolean;

    @ApiProperty({ type: String, format: 'date-time', description: 'When Dispatch received the complaint' })
    receivedAt!: Date;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the complaint was opened in the CRM' })
    openedAt!: Date;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the case was taken or assigned. null while `received`' })
    assignedAt!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the verdict was issued. null until `decided`' })
    decidedAt!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', description: 'Last change of the case' })
    updatedAt!: Date;
}

export class ComplaintAffectedItemDto {
    @ApiProperty({ type: String, required: false, description: 'Package of the dispatch the complaint is about' })
    packageId?: string;

    @ApiProperty({ type: String, required: false, description: 'Item code the complaint is about' })
    itemCode?: string;

    @ApiProperty({ type: 'integer', minimum: 1, description: 'Units affected' })
    quantity!: number;
}

/** The case with its investigation: findings, verdict, who and when, the RMA references and the route batch. */
export class ComplaintCaseDetailDto extends ComplaintCaseItemDto {
    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the investigation started. null before `in_investigation`' })
    investigationStartedAt!: Date | null;

    @ApiProperty({ type: String, nullable: true, description: 'Sanitized findings of the investigation. null until the verdict' })
    findings!: string | null;

    @ApiProperty({ type: String, nullable: true, description: 'Reason (causal) of the verdict. null until `decided`' })
    decisionReason!: string | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'User who issued the verdict. null until `decided`' })
    decidedByUserId!: number | null;

    @ApiProperty({ type: String, nullable: true, description: 'Full name of the user who issued the verdict. null until `decided`' })
    decidedByUserName!: string | null;

    @ApiProperty({ type: String, nullable: true, description: 'ID of the RMA authorization request sent to Inventory. null without `request_RMA`' })
    authorizationRequestId!: string | null;

    @ApiProperty({ type: String, nullable: true, description: 'RMA ID once Inventory approves it. null until then' })
    rmaId!: string | null;

    @ApiProperty({ type: [ComplaintAffectedItemDto], description: 'Items of the dispatch the complaint is about' })
    affectedItems!: ComplaintAffectedItemDto[];

    @ApiProperty({ type: 'integer', nullable: true, description: 'Route batch of the dispatch. null if it has none' })
    routeBatchId!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'in_execution', description: 'Status of that route batch. A case can be read while the batch is still `in_execution`' })
    routeBatchStatus!: string | null;
}

export class FindComplaintCasesResponseDto extends PaginationResponseDto<ComplaintCaseItemDto> {
    @ApiProperty({ type: [ComplaintCaseItemDto], description: 'Cases on the current page, most recently received first' })
    declare data: ComplaintCaseItemDto[];
}
