import { ApiProperty } from '@nestjs/swagger';

export class ReturnDispatchResultDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'Id of the returned dispatch' })
    dispatchId!: number;

    @ApiProperty({ type: String, example: 'returned', description: 'Status of the dispatch after the return; always `returned`' })
    status!: string;

    @ApiProperty({ type: String, example: 'not_delivered', description: 'Status the dispatch had before the return: `incident` or `not_delivered`' })
    previousStatus!: string;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-19T15:00:00.000Z', description: 'Moment the dispatch was closed (the return); it is the date the history filters by' })
    closedAt!: string;

    @ApiProperty({
        type: String, nullable: true, example: 'INC-CUST-ABSENT',
        description: 'Code of the reason published with the return: the reason of the most recent incident of the dispatch. `null` when the dispatch has no incident (the message goes without `reasonCode`)',
    })
    reasonCode!: string | null;

    @ApiProperty({ type: 'integer', example: 3, description: 'Delivery attempts spent by the dispatch' })
    attemptsUsed!: number;

    @ApiProperty({ type: 'integer', example: 3, description: 'Limit of delivery attempts (`max_delivery_attempts`)' })
    attemptsLimit!: number;
}
