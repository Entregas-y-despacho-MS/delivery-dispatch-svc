import { describe, expect, it, vi } from 'vitest';
import type { EntityManager, Repository } from 'typeorm';
import { SettingsService } from './settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { Setting } from '../entities/setting.entity.js';
import { InvalidSettingValueException, SettingNotFoundException } from '../exceptions/index.js';
import { SETTINGS_VERSION_KEY } from '../settings.constants.js';
import { MemoryCacheAdapter } from '../../../plugins/cache/memory/memory-cache.adapter.js';

function build() {
    const operationalSettings = {
        route_cutoff_time: '15:00',
        final_review_end_time: '16:00',
        route_reminder_time: '16:30',
        service_min_operating_days: '2',
        service_max_operating_days: '3',
        morning_window_start: '09:00',
        morning_window_end: '13:00',
        afternoon_window_start: '14:00',
        afternoon_window_end: '18:00',
        final_review_escalation_time: '07:00',
        warehouse_prep_end_time: '08:15',
    };
    const settings = new Map<string, Setting>([
        ['delivery_window_start', { key: 'delivery_window_start', value: '08:00', description: null, updatedAt: new Date() }],
        ['delivery_window_end', { key: 'delivery_window_end', value: '20:00', description: null, updatedAt: new Date() }],
        ['max_wait_time_min', { key: 'max_wait_time_min', value: '15', description: null, updatedAt: new Date() }],
        ['sla_alert_threshold_pct', { key: 'sla_alert_threshold_pct', value: '90', description: null, updatedAt: new Date() }],
        ['password_min_length', { key: 'password_min_length', value: '8', description: null, updatedAt: new Date() }],
        ['password_expiration_days', { key: 'password_expiration_days', value: '90', description: null, updatedAt: new Date() }],
        ['otp_code_length', { key: 'otp_code_length', value: '6', description: null, updatedAt: new Date() }],
        ['otp_expiry_minutes', { key: 'otp_expiry_minutes', value: '60', description: null, updatedAt: new Date() }],
        ['max_failed_login_attempts', { key: 'max_failed_login_attempts', value: '5', description: null, updatedAt: new Date() }],
        ['account_lockout_minutes', { key: 'account_lockout_minutes', value: '15', description: null, updatedAt: new Date() }],
        ['password_reset_expiry_minutes', { key: 'password_reset_expiry_minutes', value: '30', description: null, updatedAt: new Date() }],
        ['session_inactivity_minutes', { key: 'session_inactivity_minutes', value: '30', description: null, updatedAt: new Date() }],
        ['order_reservation_ttl_minutes', { key: 'order_reservation_ttl_minutes', value: '15', description: null, updatedAt: new Date() }],
        ...Object.entries(operationalSettings).map(([key, value]) => [key, { key, value, description: null, updatedAt: new Date() }] as const),
        [SETTINGS_VERSION_KEY, { key: SETTINGS_VERSION_KEY, value: '0', description: 'version', updatedAt: new Date() }],
    ]);
    let repositoryReference: Repository<Setting>;
    const manager = {
        transaction: vi.fn(async <T>(callback: (manager: EntityManager) => Promise<T>): Promise<T> => {
            return await callback({ getRepository: () => repositoryReference } as unknown as EntityManager);
        }),
    };
    const repository = {
        find: vi.fn(async () => [...settings.values()].sort((a, b) => a.key.localeCompare(b.key))),
        findOneBy: vi.fn(async ({ key }: { key: string }) => settings.get(key) ?? null),
        update: vi.fn(async (key: string, values: Partial<Setting>) => {
            const current = settings.get(key);
            if (!current) return { affected: 0 };
            settings.set(key, { ...current, ...values, updatedAt: new Date() });
            return { affected: 1 };
        }),
        insert: vi.fn(async (setting: Pick<Setting, 'key' | 'value' | 'description'>) => settings.set(setting.key, { ...setting, updatedAt: new Date() } as Setting)),
        manager,
    };
    repositoryReference = repository as unknown as Repository<Setting>;
    repository.find.mockImplementation(async () => [...settings.values()].sort((a, b) => a.key.localeCompare(b.key)));
    const cache = new MemoryCacheAdapter();
    return { service: new SettingsService(repositoryReference, cache), repository, cache, settings };
}

describe('SettingsService', () => {
    it('rejects an invalid value before writing', async () => {
        const { service, repository } = build();

        await expect(service.update(SettingDto, 'session_inactivity_minutes', '-5')).rejects.toThrow(InvalidSettingValueException);
        await expect(service.update(SettingDto, 'max_failed_login_attempts', 'abc')).rejects.toThrow(InvalidSettingValueException);

        expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects cross-setting inconsistencies before writing', async () => {
        const { service, repository } = build();

        await expect(service.update(SettingDto, 'morning_window_start', '13:30')).rejects.toThrow(InvalidSettingValueException);

        expect(repository.update).not.toHaveBeenCalled();
    });

    it('updates PostgreSQL, replaces the shared snapshot and increments the version', async () => {
        const { service, repository } = build();

        const updated = await service.update(SettingDto, 'session_inactivity_minutes', '45');

        expect(updated.value).toBe('45');
        expect(repository.update).toHaveBeenCalledWith('session_inactivity_minutes', { value: '45' });
        expect(repository.update).toHaveBeenCalledWith(SETTINGS_VERSION_KEY, { value: '1' });
        await expect(service.getNumber('session_inactivity_minutes', 30)).resolves.toBe(45);
        await expect(service.getVersion()).resolves.toBe(1);
    });

    it('returns PostgreSQL values when the cache is unavailable', async () => {
        const { service, cache } = build();
        vi.spyOn(cache, 'get').mockRejectedValue(new Error('offline'));
        vi.spyOn(cache, 'setIfNewer').mockRejectedValue(new Error('offline'));

        await expect(service.getNumber('session_inactivity_minutes', 5)).resolves.toBe(30);
    });

    it('does not expose or allow changing the internal version setting', async () => {
        const { service } = build();

        const settings = await service.findAll(SettingDto);
        expect(settings.some(({ key }) => key === SETTINGS_VERSION_KEY)).toBe(false);
        await expect(service.update(SettingDto, SETTINGS_VERSION_KEY, '10')).rejects.toThrow(InvalidSettingValueException);
    });

    it('returns 404 for unknown settings', async () => {
        const { service } = build();

        await expect(service.update(SettingDto, 'no_such_key', '1')).rejects.toThrow(SettingNotFoundException);
    });
});
