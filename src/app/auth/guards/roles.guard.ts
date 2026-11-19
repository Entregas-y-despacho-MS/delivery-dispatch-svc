import { Injectable, CanActivate, ExecutionContext, HttpStatus, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { AuthUser } from '../strategies/jwt.strategy.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { InsufficientPermissionsException } from '../exceptions/index.js';
import { AdminAuditService } from '../../../modules/audit/admin-audit-events/services/admin-audit.service.js';

// No numeric hierarchy — ADMIN/COORDINATOR/SUPERVISOR/DRIVER are parallel, compared by name
// against the endpoint's allowed-roles list. ROOT is the only hierarchical case: it bypasses
// this check entirely, regardless of what the endpoint requires (seed/break-glass account).
@Injectable()
export class RolesGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        // Records the denial of a sensitive action (RF-A35); guards run before interceptors.
        @Optional() private readonly audit?: AdminAuditService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const requiredRoles = this.reflector.getAllAndOverride<RoleEnum[]>(ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (!requiredRoles || requiredRoles.length === 0) return true;

        const { user }: { user: AuthUser } = context.switchToHttp().getRequest();

        // @Public() routes bypass JwtAuthGuard so user may be undefined here.
        if (!user) return true;

        if (user.role === RoleEnum.ROOT) return true;

        if (requiredRoles.includes(user.role)) return true;

        await this.audit?.recordOutcome(context, HttpStatus.FORBIDDEN);
        throw new InsufficientPermissionsException();
    }
}
