import { ApiProperty } from '@nestjs/swagger';

export class ReassignRouteBatchResponseDto {
    @ApiProperty({ example: 42, description: 'The origin route batch.' })
    fromBatchId!: number;

    @ApiProperty({ example: 55, description: 'The destination route batch.' })
    toBatchId!: number;

    @ApiProperty({ type: [Number], example: [101, 102], description: 'Dispatches actually moved, in the order they were requested.' })
    movedDispatchIds!: number[];

    @ApiProperty({ example: 7, description: 'Version of the origin batch after the move.' })
    fromVersion!: number;

    @ApiProperty({ example: 12, description: 'Version of the destination batch after the move.' })
    toVersion!: number;

    @ApiProperty({ example: false, description: 'Whether the origin batch closed because no dispatch of it was left in an open state (D-50).' })
    fromBatchClosed!: boolean;
}
