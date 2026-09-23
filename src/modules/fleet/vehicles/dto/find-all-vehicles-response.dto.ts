import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { VehicleDto } from './vehicle.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllVehiclesResponseDto extends PaginationResponseDto<VehicleDto> {
    @ApiProperty({ type: [VehicleDto] })
    declare data: VehicleDto[];
}
