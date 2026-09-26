import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtConfig } from '../config/jwt.config.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { UsersService } from '../../../modules/auth/users/services/users.service.js';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { isPasswordChangeRequired } from '../utils/password-change.util.js';

// Keep the payload minimal — data here is embedded in every token and may become stale.
// It only identifies the user: role, status and password state are read from the database on every
// request (see validate()), so they are never stale.
export interface JwtPayload {
    sub:      number; // user id
    username: string;
    roleId:   number;
    role:     RoleEnum;
    // Standard registered JWT claims — jsonwebtoken adds these automatically on sign(), not part
    // of the object we pass in. Typed here (optional) so auth.service.ts can read payload.iat for
    // the RF-A24 inactivity check without an `as any` cast.
    iat?:     number;
    exp?:     number;
}

// Shape of request.user after validate() runs. Accessed via @CurrentUser().
export interface AuthUser {
    id:       number;
    username: string;
    roleId:   number;
    role:     RoleEnum;
    // RF-A25 — the account must change its password before doing anything else (PasswordChangeGuard).
    mustChangePassword: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    constructor(
        jwtConfig: JwtConfig,
        private readonly usersService: UsersService,
        private readonly settings:     SettingsService,
    ) {
        super({
            jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey:      jwtConfig.secret,
        });
    }

    /**
     * The signature and expiry are already verified by passport-jwt; this decides whether the token is
     * still good for the user it names. It used to trust the token blindly for its whole life (15 min),
     * so a deactivated or deleted user, a role change or a password reset only took effect after it
     * expired. Returning null answers 401 INVALID_TOKEN.
     */
    async validate(payload: JwtPayload): Promise<AuthUser | null> {
        const user = await this.usersService.findForAuthentication(payload.sub);
        if (!user || !user.active) return null;

        // A token issued before the last password change is a token of the old password (a stolen one, or
        // one from another device): the change closes it. JWT `iat` has second resolution, so compare in seconds.
        if (payload.iat !== undefined && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) return null;

        return {
            id:       user.id,
            username: user.username,
            roleId:   user.roleId,
            role:     user.role,
            mustChangePassword: isPasswordChangeRequired(user, this.settings.getNumber('password_expiration_days', 90)),
        };
    }
}
