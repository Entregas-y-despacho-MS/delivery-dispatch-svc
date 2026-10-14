import { ApiProperty } from '@nestjs/swagger';

export class RouteBatchReviewerDto {
    @ApiProperty({ type: 'integer', example: 40, description: 'Id of the route batch' })
    id!: number;

    @ApiProperty({ type: String, example: 'provisional', description: 'Current status of the batch (never changed by this operation)' })
    status!: string;

    @ApiProperty({ type: 'integer', nullable: true, example: 12, description: 'User that reviews the whole batch after the request; null when it has no reviewer and is visible to everyone' })
    reviewerUserId!: number | null;

    @ApiProperty({ type: 'integer', example: 0, description: 'Planning version of the batch. Reassigning the reviewer does not change it' })
    version!: number;
}
