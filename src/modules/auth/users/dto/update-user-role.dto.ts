import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, Max } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

export class UpdateUserRoleDto {
    @ApiProperty({ type: 'integer', example: 2, description: 'New role, an ID from GET /roles. Required — this endpoint only changes the role. An unknown ID is a 400 INVALID_ROLE' })
    @IsInt({ message: 'Role ID must be an integer.' })
    @IsPositive({ message: 'Role ID must be a positive number.' })
    @Max(INT4_MAX, { message: 'Role ID is too large.' })
    roleId: number;
}
