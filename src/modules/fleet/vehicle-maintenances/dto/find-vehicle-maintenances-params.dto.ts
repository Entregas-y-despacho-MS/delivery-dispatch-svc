import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { MaintenanceStatusEnum } from '../../../../shared/enums/index.js';

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

export class FindVehicleMaintenancesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ type: 'integer', description: 'Only the maintenances of this vehicle' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'vehicleId' parameter must be an integer." })
    @Min(1, { message: "The 'vehicleId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'vehicleId' parameter must be <= ${INT4_MAX}.` })
    vehicleId?: number;

    @ApiPropertyOptional({ enum: MaintenanceStatusEnum, description: 'Only maintenances in this status' })
    @IsOptional()
    @Transform(lower)
    @IsIn(Object.values(MaintenanceStatusEnum), { message: `The 'status' parameter must be one of: ${Object.values(MaintenanceStatusEnum).join(', ')}.` })
    status?: MaintenanceStatusEnum;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'First day of the range, YYYY-MM-DD, inclusive. Bolivia days (America/La_Paz), matched against the registration date of the maintenance' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from?: string;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'Last day of the range, YYYY-MM-DD, inclusive (the whole day counts). Bolivia days, matched against the registration date. Must not be before `from`' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to?: string;
}
