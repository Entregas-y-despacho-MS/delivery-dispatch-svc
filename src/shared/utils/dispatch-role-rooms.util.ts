import { RoleEnum } from '../enums/index.js';

/** App-level Socket.IO rooms shared by connection handlers and event publishers. */
export const dispatchRoleRooms = (role: RoleEnum, userId: number): string[] => {
    if (role === RoleEnum.COORDINATOR || role === RoleEnum.ROOT) return ['coordinators'];
    if (role === RoleEnum.SUPERVISOR) return ['supervisors'];
    if (role === RoleEnum.DRIVER) return [`driver:${userId}`];
    return [];
};
