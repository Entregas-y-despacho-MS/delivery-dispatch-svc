import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { VehicleIncidentTypeDto } from './vehicle-incident-type.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllVehicleIncidentTypesResponseDto extends PaginationResponseDto<VehicleIncidentTypeDto> {
    @ApiProperty({ type: [VehicleIncidentTypeDto] })
    declare data: VehicleIncidentTypeDto[];
}
