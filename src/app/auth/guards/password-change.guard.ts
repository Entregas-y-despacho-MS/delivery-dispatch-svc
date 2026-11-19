import { CanActivate, ExecutionContext, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PASSWORD_CHANGE_KEY } from '../decorators/allow-password-change.decorator.js';
import type { AuthUser } from '../strategies/jwt.strategy.js';
import { PasswordChangeRequiredException } from '../exceptions/index.js';
import { AdminAuditService } from '../../../modules/audit/admin-audit-events/services/admin-audit.service.js';

/**
 * RF-A25 — until the password is changed, the account can do nothing else. `mustChangePassword` used to be
 * only a hint returned at login for the client to act on; the API itself stayed fully usable. Registered as
 * APP_GUARD after JwtAuthGuard (which fills request.user).
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        // Records the denial of a sensitive action (RF-A35); guards run before interceptors.
        @Optional() private readonly audit?: AdminAuditService,
    ) {}

    canActivate(context: ExecutionContext): boolean {
        const { user }: { user?: AuthUser } = context.switchToHttp().getRequest();
        // Public routes have no user; nothing to enforce.
        if (!user?.mustChangePassword) return true;

        const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_KEY, [context.getHandler(), context.getClass()]);
        if (allowed) return true;

        // Not awaited: this guard stays synchronous, and recording never throws.
        void this.audit?.recordOutcome(context, HttpStatus.FORBIDDEN);
        throw new PasswordChangeRequiredException();
    }
}
