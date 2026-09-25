import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export class FindAllServiceLevelsParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ maxLength: 100, description: 'E.g. express. Text contained in the name or the description (case-insensitive; % and _ are matched literally). Combined with `active`, both apply' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ description: 'true = only enabled levels, false = only disabled ones. Omit (or send it empty) for all. Any other value is rejected with 400' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;
}
