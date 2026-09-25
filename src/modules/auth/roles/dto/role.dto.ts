import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class RoleDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Role ID. Use it as `roleId` when creating or updating users' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'admin', enum: ['root', 'admin', 'coordinator', 'supervisor', 'driver'], description: 'Role name. root is the system account and can do everything; the others are independent of each other, each with its own permissions' })
    name!: string;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;
}
