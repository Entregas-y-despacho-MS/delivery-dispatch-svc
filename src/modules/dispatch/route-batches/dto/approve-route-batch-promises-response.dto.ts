import { ApiProperty } from '@nestjs/swagger';

export class PromiseEmailResultDto {
    @ApiProperty({ example: 42 }) dispatchId!: number;
    @ApiProperty({ enum: ['sent', 'bounced', 'failed', 'skipped'] }) result!: 'sent' | 'bounced' | 'failed' | 'skipped';
}

export class ApproveRouteBatchPromisesResponseDto {
    @ApiProperty({ example: 8 }) routeBatchId!: number;
    @ApiProperty({ example: 8 }) version!: number;
    @ApiProperty({ example: 3 }) approvedCount!: number;
    @ApiProperty({ example: 1 }) removedCount!: number;
    @ApiProperty({ example: 3, description: 'Number of customer emails attempted after the transaction committed.' }) emailCount!: number;
    @ApiProperty({ type: [PromiseEmailResultDto] }) emailResults!: PromiseEmailResultDto[];
}
