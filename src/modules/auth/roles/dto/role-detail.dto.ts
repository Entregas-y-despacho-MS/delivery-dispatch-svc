import { ApiProperty } from '@nestjs/swagger';
import { RoleDto } from './role.dto.js';

/** A role as listed by GET /roles: the role plus how many users have it. */
export class RoleDetailDto extends RoleDto {
    @ApiProperty({ type: 'integer', example: 4, description: 'How many users (not deleted) have this role, active or not' })
    userCount!: number;

    @ApiProperty({ type: 'integer', example: 3, description: 'How many of those users are active (can log in)' })
    activeUserCount!: number;
}
