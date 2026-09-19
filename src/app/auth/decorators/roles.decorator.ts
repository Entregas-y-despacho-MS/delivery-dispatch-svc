import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { errorBody } from '../../../shared/utils/swagger/index.js';
import { RoleEnum } from '../../../shared/enums/index.js';

export const ROLES_KEY = 'required_roles';

const forbidden = (description: string) =>
    ApiForbiddenResponse({
        description,
        schema: { example: errorBody(403, 'INSUFFICIENT_PERMISSIONS', 'You do not have permission to perform this action.') },
    });

/**
 * Restricts an endpoint to the given roles — flat list, no hierarchy implied between them
 * (ADMIN does not imply COORDINATOR/SUPERVISOR/DRIVER, nor the other way around).
 * ROOT always passes regardless of this list (see RolesGuard) — the only hierarchical case,
 * for the seed/break-glass account that must never be locked out of anything.
 */
export const Roles = (...roles: RoleEnum[]) =>
    applyDecorators(
        SetMetadata(ROLES_KEY, roles),
        forbidden(`Requires one of: ${roles.join(', ')}.`),
    );

/** ROOT only — seed/break-glass account, not for daily operation. */
export const RootOnly = () => Roles(RoleEnum.ROOT);

/** ADMIN only — user management, catalogs, settings. Does not include ROOT (use Roles() for that). */
export const AdminOnly = () => Roles(RoleEnum.ADMIN);

/** COORDINATOR only — day-to-day dispatch operations. */
export const CoordinatorOnly = () => Roles(RoleEnum.COORDINATOR);

/** SUPERVISOR only — day-to-day fleet operations. */
export const SupervisorOnly = () => Roles(RoleEnum.SUPERVISOR);

/** DRIVER only — mobile app, field operations. */
export const DriverOnly = () => Roles(RoleEnum.DRIVER);
