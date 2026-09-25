import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import { DtoField, DtoRelation } from '../../../../shared/orm/index.js';
import { UserStatusEnum } from '../../../../shared/enums/index.js';
import { RoleDto } from '../../roles/dto/role.dto.js';
import { computeUserStatus } from '../utils/user-status.util.js';

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

    // Derived from `active` + `lockedUntil` — not a column, so @Expose (not @DtoField): it must not
    // end up in the SELECT. Both source columns are selected because they are @DtoField below.
    @Expose()
    @Transform(({ obj }) => computeUserStatus(obj.active, obj.lockedUntil))
    @ApiProperty({
        enum:        UserStatusEnum,
        example:     UserStatusEnum.ACTIVE,
        description: 'inactive = deactivated by an admin · locked = temporarily locked after failed logins · active = everything else.',
    })
    status!: UserStatusEnum;

    @DtoField()
    @ApiProperty({ example: null, nullable: true, description: 'While in the future, the account is locked (RF-A21). Null when never locked.' })
    lockedUntil!: Date | null;

    @DtoField()
    @ApiProperty({ example: '2026-09-24T14:03:00.000Z', nullable: true, description: 'Last successful login. Null if the user has never logged in.' })
    lastLoginAt!: Date | null;

    @DtoField()
    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    createdAt!: Date;
}
