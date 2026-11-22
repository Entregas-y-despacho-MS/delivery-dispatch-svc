import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import type { ComplaintVerdict } from '../../../messaging/complaint-intake/entities/delivery-complaint-case.entity.js';

/** The only verdicts a case accepts (RF-U22). */
export const COMPLAINT_VERDICTS: readonly ComplaintVerdict[] = ['no_return_required', 'request_RMA', 'not_confirmed'];

/**
 * Removes control characters (keeps line breaks and tabs) and the invisible ones (zero-width spaces and joiners,
 * direction marks, word joiner, BOM) and trims, so stored text is plain and a reason of only invisible characters is empty.
 */
const isPlainChar = (char: string): boolean => {
    const code = char.charCodeAt(0);
    if (code === 0x09 || code === 0x0A || code === 0x0D) return true;
    const invisible = (code >= 0x200B && code <= 0x200F) || (code >= 0x202A && code <= 0x202E) || code === 0x2060 || code === 0xFEFF;
    return code >= 0x20 && code !== 0x7F && !invisible;
};
const sanitize = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? [...value].filter(isPlainChar).join('').trim() : value;

// The investigation text never carries a link: the API does not hand out public evidence URLs (HU rule 6).
// Any `scheme://`, `www.` and `javascript:` are links; a bare domain without scheme cannot be told from ordinary text.
const NO_URL = /^(?!.*(?:[a-z][a-z0-9+.-]*:\/\/|www\.|javascript:)).*$/is;

export class ComplaintCaseCommandDto {
    @ApiProperty({
        type: 'integer', minimum: 1, maximum: INT4_MAX, example: 1,
        description: '`caseVersion` the person read. If CRM has sent a newer version since, the command is rejected with 409 `COMPLAINT_CASE_VERSION_STALE` and nothing changes: read the case again first',
    })
    @Type(() => Number)
    @IsInt({ message: 'expectedVersion must be an integer.' })
    @Min(1, { message: 'expectedVersion must be >= 1.' })
    @Max(INT4_MAX, { message: `expectedVersion must be <= ${INT4_MAX}.` })
    expectedVersion!: number;
}

export class AssignComplaintCaseDto extends ComplaintCaseCommandDto {
    @ApiPropertyOptional({
        type: 'integer', minimum: 1, maximum: 2147483647, example: 7,
        description: 'User to put in charge of the case: an active coordinator or supervisor. Omitted: the person making the request takes the case',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: 'assigneeUserId must be an integer.' })
    @Min(1, { message: 'assigneeUserId must be >= 1.' })
    @Max(INT4_MAX, { message: `assigneeUserId must be <= ${INT4_MAX}.` })
    assigneeUserId?: number;
}

export class StartComplaintInvestigationDto extends ComplaintCaseCommandDto {}

export class IssueComplaintVerdictDto extends ComplaintCaseCommandDto {
    @ApiProperty({ enum: COMPLAINT_VERDICTS, example: 'request_RMA', description: 'Operational verdict. `request_RMA` stores the verdict, leaves the case `authorization_pending` and asks Inventory to authorize the return; it creates no pickup. `no_return_required` and `not_confirmed` request nothing' })
    @IsIn(COMPLAINT_VERDICTS, { message: `verdict must be one of: ${COMPLAINT_VERDICTS.join(', ')}.` })
    verdict!: ComplaintVerdict;

    @ApiProperty({ type: String, maxLength: 500, example: 'Factory damage confirmed with the delivery evidence.', description: 'Reason (causal) of the verdict, 1 to 500 characters. No links' })
    @Transform(sanitize)
    @IsString({ message: 'decisionReason must be a string.' })
    @IsNotEmpty({ message: 'decisionReason must not be empty.' })
    @MaxLength(500, { message: 'decisionReason must not exceed 500 characters.' })
    @Matches(NO_URL, { message: 'decisionReason must not contain links.' })
    decisionReason!: string;

    @ApiProperty({ type: String, maxLength: 4000, example: 'The item arrived with a cracked casing; the driver photo shows it before the handover.', description: 'Findings of the investigation, 1 to 4000 characters. Plain text with no links: evidence is referenced, never published' })
    @Transform(sanitize)
    @IsString({ message: 'findings must be a string.' })
    @IsNotEmpty({ message: 'findings must not be empty.' })
    @MaxLength(4000, { message: 'findings must not exceed 4000 characters.' })
    @Matches(NO_URL, { message: 'findings must not contain links.' })
    findings!: string;
}
