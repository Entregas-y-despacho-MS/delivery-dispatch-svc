import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { InvalidTokenException } from '../exceptions/index.js';

export const IS_PUBLIC_KEY = 'isPublic';

// Registered as APP_GUARD in AppModule — protects all routes by default.
// Decorate a handler or controller with @Public() to opt out.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(private readonly reflector: Reflector) {
        super();
    }

    canActivate(context: ExecutionContext) {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (isPublic) return true;

        return super.canActivate(context);
    }

    handleRequest(err: any, user: any) {
        if (err || !user) throw new InvalidTokenException();
        return user;
    }
}
