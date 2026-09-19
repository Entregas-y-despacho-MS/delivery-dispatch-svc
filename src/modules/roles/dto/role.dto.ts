import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../shared/orm/index.js';

export class RoleDto {
    @DtoField()
    @ApiProperty({ example: 1 })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'admin' })
    name!: string;

    @DtoField()
    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    createdAt!: Date;
}
