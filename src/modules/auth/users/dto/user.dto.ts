import { ApiProperty } from '@nestjs/swagger';
import { DtoField, DtoRelation } from '../../../../shared/orm/index.js';
import { RoleDto } from '../../roles/dto/role.dto.js';

export class UserDto {
    @DtoField()
    @ApiProperty({ example: 1 })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'Ana Torrez' })
    fullName!: string;

    @DtoField()
    @ApiProperty({ example: 'atorrez' })
    username!: string;

    @DtoField()
    @ApiProperty({ example: 'ana@hipermaxi.com', nullable: true })
    email!: string | null;

    @DtoRelation(() => RoleDto)
    @ApiProperty({ type: () => RoleDto })
    role!: RoleDto;

    @DtoField()
    @ApiProperty({ example: true })
    active!: boolean;

    @DtoField()
    @ApiProperty({ example: false })
    twoFactorEnabled!: boolean;

    @DtoField()
    @ApiProperty({ example: false, description: 'true if the user must change their password before continuing.' })
    requiresPwdChange!: boolean;

    @DtoField()
    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    createdAt!: Date;
}
