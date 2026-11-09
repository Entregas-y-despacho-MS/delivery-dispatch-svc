import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../shared/orm/index.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum, OperationalAlertStatusEnum } from '../../../shared/enums/operational-alert.enum.js';

export class OperationalAlertDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Operational alert ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ enum: OperationalAlertKindEnum, example: OperationalAlertKindEnum.CRITICAL_INCIDENT, description: 'What raised the alert' })
    kind!: OperationalAlertKindEnum;

    @DtoField()
    @ApiProperty({ enum: OperationalAlertSeverityEnum, example: OperationalAlertSeverityEnum.CRITICAL, description: 'critical_incident is always critical; the threshold-based kinds are warning' })
    severity!: OperationalAlertSeverityEnum;

    @DtoField()
    @ApiProperty({ type: 'integer', nullable: true, example: 3, description: 'Zone the alert concerns. null when it does not apply to a specific zone' })
    zoneId!: number | null;

    @DtoField()
    @ApiProperty({ type: 'integer', nullable: true, example: 55, description: 'Dispatch the alert concerns (critical_incident). null for the other kinds' })
    dispatchId!: number | null;

    @DtoField()
    @ApiProperty({ type: 'integer', nullable: true, example: 7, description: 'Driver the alert concerns (critical_incident, gps_stale, driver_incidents). null for sla_below_threshold' })
    driverId!: number | null;

    @DtoField()
    @ApiProperty({ type: 'integer', nullable: true, example: 4, description: 'Vehicle the driver was using when the alert was raised, when known. Informational only — never part of the deduplication key' })
    vehicleId!: number | null;

    @DtoField()
    @ApiProperty({ type: 'object', properties: {}, additionalProperties: true, example: { reasonCode: 'INC-ACCIDENT' }, description: 'Extra context specific to the kind (e.g. the incident reason code, the measured value against its threshold)' })
    detail!: Record<string, unknown>;

    @DtoField()
    @ApiProperty({ enum: OperationalAlertStatusEnum, example: OperationalAlertStatusEnum.OPEN, description: 'open until a supervisor/coordinator acknowledges it' })
    status!: OperationalAlertStatusEnum;

    @DtoField()
    @ApiProperty({ type: 'integer', nullable: true, example: 2, description: 'User who acknowledged the alert. null while open' })
    acknowledgedBy!: number | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-11-09T14:05:00.000Z', description: 'When it was acknowledged. null while open' })
    acknowledgedAt!: Date | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2026-11-09T14:00:00.000Z', description: 'When the alert was raised' })
    createdAt!: Date;
}
