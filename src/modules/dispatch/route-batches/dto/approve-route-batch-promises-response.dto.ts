import { ApiProperty } from '@nestjs/swagger';

export class PromiseEmailResultDto {
    @ApiProperty({ example: 42, description: 'ID of the dispatch associated with this email attempt.' })
    dispatchId!: number;

    @ApiProperty({
        enum: ['sent', 'bounced', 'failed', 'skipped'],
        description: 'Delivery outcome: sent, bounced, failed, or skipped because no customer email was available.',
    })
    result!: 'sent' | 'bounced' | 'failed' | 'skipped';
}

export class ApproveRouteBatchPromisesResponseDto {
    @ApiProperty({ example: 8, description: 'ID of the approved route batch.' })
    routeBatchId!: number;

    @ApiProperty({ example: 8, description: 'Route-batch version after approval.' })
    version!: number;

    @ApiProperty({ example: 3, description: 'Number of dispatches approved in the batch.' })
    approvedCount!: number;

    @ApiProperty({ example: 1, description: 'Number of dispatches removed from the batch and returned to pending.' })
    removedCount!: number;
    @ApiProperty({ example: 3, description: 'Number of customer emails attempted after the transaction committed.' }) emailCount!: number;
    @ApiProperty({ type: [PromiseEmailResultDto], description: 'Email delivery result for each approved dispatch.' })
    emailResults!: PromiseEmailResultDto[];
}
