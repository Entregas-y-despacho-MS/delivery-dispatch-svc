import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { MaintenanceStatusEnum } from '../../../../shared/enums/index.js';

export class ChangeMaintenanceStatusDto {
    @ApiProperty({ enum: MaintenanceStatusEnum, example: MaintenanceStatusEnum.IN_PROGRESS, description: 'Next status. Only pending to in_progress and in_progress to completed are allowed' })
    @IsEnum(MaintenanceStatusEnum, { message: 'Status must be pending, in_progress, or completed.' })
    status!: MaintenanceStatusEnum;
}
