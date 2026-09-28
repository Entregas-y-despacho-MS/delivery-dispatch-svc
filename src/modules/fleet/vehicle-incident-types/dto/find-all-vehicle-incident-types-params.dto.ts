import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { VehicleIncidentSeverityEnum } from '../../../../shared/enums/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export enum VehicleIncidentTypeSortBy {
    CODE       = 'code',
    NAME       = 'name',
    SEVERITY   = 'severity',
    CREATED_AT = 'createdAt',
}

export class FindAllVehicleIncidentTypesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ maxLength: 100, description: 'E.g. frenos. Text contained in the code or the name (case-insensitive; % and _ are matched literally)' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ enum: VehicleIncidentSeverityEnum, description: 'Only incident types of this severity. Omit for all' })
    @IsOptional()
    @IsEnum(VehicleIncidentSeverityEnum, { message: "The 'severity' parameter must be one of: minor, moderate, critical." })
    severity?: VehicleIncidentSeverityEnum;

    @ApiPropertyOptional({ description: 'true = only types that disable the vehicle, false = only the ones that don\'t. Omit (or send it empty) for all. Any other value is rejected with 400' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'disablesVehicle'))
    @IsBoolean()
    disablesVehicle?: boolean;

    @ApiPropertyOptional({ enum: VehicleIncidentTypeSortBy, default: VehicleIncidentTypeSortBy.NAME, description: 'Field to sort by. Default: name' })
    @IsOptional()
    @IsIn(Object.values(VehicleIncidentTypeSortBy), { message: "The 'sortBy' parameter must be one of: code, name, severity, createdAt." })
    sortBy?: VehicleIncidentTypeSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction. Default: asc' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(['asc', 'desc'], { message: "The 'sortOrder' parameter must be 'asc' or 'desc'." })
    sortOrder?: 'asc' | 'desc';
}
