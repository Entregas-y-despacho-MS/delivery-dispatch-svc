import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { ALERT_THRESHOLD_LIMITS as LIMITS } from '../settings.constants.js';

export class UpdateAlertThresholdsDto {
    @ApiProperty({ type: 'integer', minimum: LIMITS.slaAlertMinOnTimePct.min, maximum: LIMITS.slaAlertMinOnTimePct.max, example: 90, description: 'Minimum percentage of on-time deliveries (0-100). Below it, an SLA alert is raised.' })
    @IsInt()
    @Min(LIMITS.slaAlertMinOnTimePct.min)
    @Max(LIMITS.slaAlertMinOnTimePct.max)
    slaAlertMinOnTimePct!: number;

    @ApiProperty({ type: 'integer', minimum: LIMITS.gpsStaleAlertMinutes.min, maximum: LIMITS.gpsStaleAlertMinutes.max, example: 5, description: 'Minutes without a GPS position from a driver on route before a stale-GPS alert is raised (at least 1).' })
    @IsInt()
    @Min(LIMITS.gpsStaleAlertMinutes.min)
    @Max(LIMITS.gpsStaleAlertMinutes.max)
    gpsStaleAlertMinutes!: number;

    @ApiProperty({ type: 'integer', minimum: LIMITS.driverIncidentAlertPerDay.min, maximum: LIMITS.driverIncidentAlertPerDay.max, example: 3, description: 'Incidents reported by one driver in a day that raise a driver-incidents alert (at least 1).' })
    @IsInt()
    @Min(LIMITS.driverIncidentAlertPerDay.min)
    @Max(LIMITS.driverIncidentAlertPerDay.max)
    driverIncidentAlertPerDay!: number;
}
