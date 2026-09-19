import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtConfig } from '../config/jwt.config.js';
import { RoleEnum } from '../../../shared/enums/index.js';

// Keep the payload minimal — data here is embedded in every token and may become stale.
// `role` (name) drives RolesGuard — `roleId` (FK) kept too, for queries/joins that need it.
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
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    constructor(jwtConfig: JwtConfig) {
        super({
            jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey:      jwtConfig.secret,
        });
    }

    // payload is already verified by passport-jwt — no DB lookup needed here by default.
    validate(payload: JwtPayload): AuthUser {
        return {
            id:       payload.sub,
            username: payload.username,
            roleId:   payload.roleId,
            role:     payload.role,
        };
    }
}
