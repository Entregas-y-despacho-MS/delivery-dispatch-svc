import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { RoleDto } from './role.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllRolesResponseDto extends PaginationResponseDto<RoleDto> {
    @ApiProperty({ type: [RoleDto] })
    declare data: RoleDto[];
}
