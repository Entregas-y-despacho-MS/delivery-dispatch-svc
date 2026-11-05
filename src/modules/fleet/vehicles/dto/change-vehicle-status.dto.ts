import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { VehicleStatusEnum } from '../../../../shared/enums/index.js';

export class ChangeVehicleStatusDto {
    @ApiProperty({ enum: VehicleStatusEnum, example: VehicleStatusEnum.MAINTENANCE, description: 'New operational status of the vehicle.' })
    @IsEnum(VehicleStatusEnum, { message: 'Status must be active, maintenance, or out_of_service.' })
    status!: VehicleStatusEnum;

    @ApiProperty({ example: 'Preventive maintenance scheduled after inspection.', description: 'Required reason for changing the vehicle status.' })
    @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
    @IsString({ message: 'Reason must be a string.' })
    @IsNotEmpty({ message: 'Reason is required.' })
    reason!: string;
}
