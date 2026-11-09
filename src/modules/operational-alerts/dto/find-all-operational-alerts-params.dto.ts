import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationParamsDto } from '../../../shared/dto/index.js';
import { OperationalAlertStatusEnum } from '../../../shared/enums/operational-alert.enum.js';

export class FindAllOperationalAlertsParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ enum: OperationalAlertStatusEnum, description: 'Only alerts in this status. Omit for all' })
    @IsOptional()
    @IsEnum(OperationalAlertStatusEnum, { message: "The 'status' parameter must be one of: open, acknowledged." })
    status?: OperationalAlertStatusEnum;
}
