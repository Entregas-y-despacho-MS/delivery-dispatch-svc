import { ApiProperty } from '@nestjs/swagger';

export class DispatchIncidentResponseDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'Dispatch identifier.' })
    dispatchId!: number;

    @ApiProperty({ format: 'uuid', example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', description: 'UUID v7 identifying the incident.' })
    incidentId!: string;

    @ApiProperty({ example: 'INC-CUST-ABSENT', description: 'Incident reason code.' })
    reasonCode!: string;

    @ApiProperty({ example: 'incident', description: 'Dispatch status after reporting.' })
    status!: 'incident';

    @ApiProperty({ format: 'date-time', example: '2026-10-19T14:05:00.000Z', description: 'Server time when the report was committed.' })
    reportedAt!: string;
}
