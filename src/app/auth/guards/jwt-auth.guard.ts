import { ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { InvalidTokenException } from '../exceptions/index.js';
import { AdminAuditService } from '../../../modules/audit/admin-audit-events/services/admin-audit.service.js';

export const IS_PUBLIC_KEY = 'isPublic';

// Registered as APP_GUARD in AppModule — protects all routes by default.
// Decorate a handler or controller with @Public() to opt out.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(
        private readonly reflector: Reflector,
        // Records an unauthenticated attempt at a sensitive action (RF-A35); guards run before interceptors.
        @Optional() private readonly audit?: AdminAuditService,
    ) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (isPublic) return true;

        try {
            return (await super.canActivate(context)) as boolean;
        } catch (error) {
            await this.audit?.recordError(context, error);
            throw error;
        }
    }

    handleRequest(err: any, user: any) {
        if (err || !user) throw new InvalidTokenException();
        return user;
    }
}
