import { ApiProperty } from '@nestjs/swagger';

export class AlertThresholdsDto {
    @ApiProperty({ type: 'integer', minimum: 0, maximum: 100, example: 90, description: 'Minimum percentage of on-time deliveries; below it an SLA alert is raised.' })
    slaAlertMinOnTimePct!: number;

    @ApiProperty({ type: 'integer', minimum: 1, maximum: 1440, example: 5, description: 'Minutes without a GPS position from a driver on route before a stale-GPS alert is raised.' })
    gpsStaleAlertMinutes!: number;

    @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, example: 3, description: 'Incidents reported by one driver in a day that raise a driver-incidents alert.' })
    driverIncidentAlertPerDay!: number;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-11-05T12:00:00.000Z', description: 'Last time any of the three thresholds was changed (UTC).' })
    updatedAt!: Date;
}
