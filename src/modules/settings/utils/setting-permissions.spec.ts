import { describe, expect, it } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { PASSWORD_POLICY_KEYS, canWriteSetting } from './setting-permissions.js';

describe('canWriteSetting', () => {
    it.each(PASSWORD_POLICY_KEYS)('lets only the admin (and root) change %s', (key) => {
        expect(canWriteSetting(key, RoleEnum.ADMIN)).toBe(true);
        expect(canWriteSetting(key, RoleEnum.ROOT)).toBe(true);
        for (const role of [RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR, RoleEnum.DRIVER]) {
            expect(canWriteSetting(key, role), `${role} on ${key}`).toBe(false);
        }
    });

    it.each(['delivery_window_start', 'delivery_window_end', 'max_wait_time_min', 'max_failed_login_attempts'])(
        'lets only the coordinator (and root) change %s',
        (key) => {
            expect(canWriteSetting(key, RoleEnum.COORDINATOR)).toBe(true);
            expect(canWriteSetting(key, RoleEnum.ROOT)).toBe(true);
            for (const role of [RoleEnum.ADMIN, RoleEnum.SUPERVISOR, RoleEnum.DRIVER]) {
                expect(canWriteSetting(key, role), `${role} on ${key}`).toBe(false);
            }
        },
    );
});
