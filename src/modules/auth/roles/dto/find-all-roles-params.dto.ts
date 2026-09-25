import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';

export class FindAllRolesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ example: 'admin', description: 'Text contained in the role name (case-insensitive)' })
    @IsOptional()
    @IsString()
    search?: string;
}
