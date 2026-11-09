import { ApiProperty } from '@nestjs/swagger';
import { SlaReportRowDto } from '../../sla-report/dto/sla-report.dto.js';

export class FleetReportVehicleRowDto extends SlaReportRowDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Maintenance records overlapping the requested Bolivia-day range' })
    maintenanceCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Calendar days in maintenance, clipped to the inclusive requested range; open maintenance is counted through to' })
    daysInMaintenance!: number;
}

export class FleetReportsDto {
    @ApiProperty({ type: String, format: 'date', description: 'First Bolivia day of the range, inclusive' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last Bolivia day of the range, inclusive' })
    to!: string;

    @ApiProperty({ type: [SlaReportRowDto], description: 'Driver metrics from the SLA aggregation; empty when no dispatches closed in the range' })
    drivers!: SlaReportRowDto[];

    @ApiProperty({ type: [FleetReportVehicleRowDto], description: 'Vehicle metrics from closed dispatches plus vehicles with maintenance overlapping the range; maintenance-only vehicles have zero delivery metrics' })
    vehicles!: FleetReportVehicleRowDto[];
}
