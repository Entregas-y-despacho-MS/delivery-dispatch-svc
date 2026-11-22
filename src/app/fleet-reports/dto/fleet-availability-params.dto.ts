import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../shared/constants/int4.js';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';

const dateMessage = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);
const toBoolean = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const idMessage = (name: string) => `The '${name}' parameter must be an integer between 1 and ${INT4_MAX}.`;

/**
 * Query of `GET /fleet/availability` (ST-303.1). `from`/`to` are the Bolivia-day period of maintenance and
 * productivity; `cutoff` is the day of the availability snapshot (default: today in Bolivia). The rest are filters.
 */
export class FleetAvailabilityParamsDto {
    @ApiPropertyOptional({ type: String, format: 'date', description: 'Bolivia day of the availability cut-off (YYYY-MM-DD). Defaults to today. Only the current state of the fleet is stored, so a past day answers `N/D` for the availability; a future day is rejected' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: dateMessage('cutoff') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: dateMessage('cutoff') })
    cutoff?: string;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'First Bolivia day of the maintenance and productivity period, inclusive. Defaults to `cutoff`' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: dateMessage('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: dateMessage('from') })
    from?: string;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'Last Bolivia day of the period, inclusive. Defaults to `cutoff`; the period must not exceed 366 days' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: dateMessage('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: dateMessage('to') })
    to?: string;

    @ApiPropertyOptional({ type: 'integer', description: 'Only this vehicle' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: idMessage('vehicleId') })
    @Min(1, { message: idMessage('vehicleId') })
    @Max(INT4_MAX, { message: idMessage('vehicleId') })
    vehicleId?: number;

    @ApiPropertyOptional({ type: 'integer', description: 'Only this driver. Reserved to the roles that may see the driver detail (supervisor, root); any other role gets 403' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: idMessage('driverId') })
    @Min(1, { message: idMessage('driverId') })
    @Max(INT4_MAX, { message: idMessage('driverId') })
    driverId?: number;

    @ApiPropertyOptional({ enum: VehicleStatusEnum, description: 'Only vehicles in this fleet status: `active` (assignable), `maintenance` or `out_of_service`' })
    @IsOptional()
    @Transform(lower)
    @IsIn(Object.values(VehicleStatusEnum), { message: `The 'fleetStatus' parameter must be one of: ${Object.values(VehicleStatusEnum).join(', ')}.` })
    fleetStatus?: VehicleStatusEnum;

    @ApiPropertyOptional({ type: 'integer', description: 'Only maintenances of this incident type (`vehicle_incident_type_id`); there is no other maintenance type. Excludes `routine=true`' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: idMessage('maintenanceTypeId') })
    @Min(1, { message: idMessage('maintenanceTypeId') })
    @Max(INT4_MAX, { message: idMessage('maintenanceTypeId') })
    maintenanceTypeId?: number;

    @ApiPropertyOptional({ type: Boolean, description: '`true`: only routine maintenances (no incident type); `false`: only the ones with an incident type' })
    @IsOptional()
    @Transform(toBoolean)
    @IsBoolean({ message: "The 'routine' parameter must be true or false." })
    routine?: boolean;
}
