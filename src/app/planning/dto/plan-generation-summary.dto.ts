import { ApiProperty } from '@nestjs/swagger';

export class PlanAlertDto {
    @ApiProperty({
        example: 'no_vehicle_fits',
        description: 'Kind of alert: `deadline_exceeded`, `no_vehicle_fits`, `rescheduled_date_not_plannable`, `osrm_table_limit_exceeded` (exceptions) or `below_min_orders`, `no_driver_available`, `holidays_not_configured`, `lot_split_by_table_limit`, `zone_deleted` (warnings).',
    })
    kind!: string;

    @ApiProperty({
        type: 'object',
        properties: {
            zoneId: { type: 'integer', description: 'Delivery zone id.' },
            zoneCode: { type: 'string', description: 'Delivery zone code, as the coordinator knows it.' },
            zoneName: { type: 'string', description: 'Delivery zone name.' },
            dispatchId: { type: 'integer', description: 'Order the alert is about, when it is about one.' },
            shiftDate: { type: 'string', format: 'date', description: 'Day of the route, when the alert is about a batch.' },
        },
        additionalProperties: true,
        example: { zoneId: 7, zoneCode: 'ZON-SUR', zoneName: 'Achumani', dispatchId: 1042 },
        description: 'What the alert is about. Zones carry id, code and name so the coordinator can read them; orders carry `dispatchId`.',
    })
    detail!: Record<string, unknown>;
}

export class PlanGenerationSummaryDto {
    @ApiProperty({
        example: 'executed',
        enum: ['executed', 'blocked'],
        description: '`blocked` when a mandatory setting is missing on a scheduled run (nothing was written); a manual run answers 422 instead.',
    })
    status!: 'executed' | 'blocked';

    @ApiProperty({ type: 'integer', isArray: true, description: 'Ids of the provisional batches created in this run.' })
    createdBatchIds!: number[];

    @ApiProperty({ type: 'integer', isArray: true, description: 'Ids of the open batches that received late orders in this run.' })
    updatedBatchIds!: number[];

    @ApiProperty({ type: 'integer', isArray: true, description: 'Ids of the orders that went to `in_planning` in this run, in new and open batches.' })
    plannedDispatchIds!: number[];

    @ApiProperty({ type: [PlanAlertDto], description: 'Orders that stay `pending` and need the coordinator (the ones already reported in an earlier run are listed too).' })
    exceptions!: PlanAlertDto[];

    @ApiProperty({ type: [PlanAlertDto], description: 'Things to know that did not stop the plan, such as a batch below `plan_min_orders_per_route`.' })
    warnings!: PlanAlertDto[];

    @ApiProperty({ type: [String], description: 'Mandatory settings that were empty or invalid when `status` is `blocked`.' })
    missingKeys!: string[];
}
