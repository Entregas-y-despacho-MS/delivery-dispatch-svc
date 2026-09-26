import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { RoleDetailDto } from './role-detail.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllRolesResponseDto extends PaginationResponseDto<RoleDetailDto> {
    @ApiProperty({ type: [RoleDetailDto] })
    declare data: RoleDetailDto[];
}
