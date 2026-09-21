import { ApiHideProperty } from '@nestjs/swagger';
import { DtoField, DtoRelation } from '../../../../shared/orm/index.js';
import { RoleDto } from '../../roles/dto/role.dto.js';

// Internal — includes password/refresh hashes and 2FA secret. Never return in an HTTP response,
// use UserDto.
export class UserForAuthDto {
    @DtoField() id!: number;
    @DtoField() username!: string;
    @DtoField() roleId!: number;
    @DtoField() active!: boolean;

    // Needed for JwtPayload.role (RolesGuard compares by role name, not roleId).
    @DtoRelation(() => RoleDto)
    role!: RoleDto;

    @ApiHideProperty()
    @DtoField()
    passwordHash!: string;

    @ApiHideProperty()
    @DtoField()
    refreshTokenHash!: string | null;

    @ApiHideProperty()
    @DtoField()
    failedAttempts!: number;

    @ApiHideProperty()
    @DtoField()
    lockedUntil!: Date | null;

    @ApiHideProperty()
    @DtoField()
    twoFactorSecret!: string | null;

    @ApiHideProperty()
    @DtoField()
    twoFactorEnabled!: boolean;

    @ApiHideProperty()
    @DtoField()
    passwordResetExpiresAt!: Date | null;

    @ApiHideProperty()
    @DtoField()
    requiresPwdChange!: boolean;

    @ApiHideProperty()
    @DtoField()
    passwordChangedAt!: Date;
}
