// SettingsService.update validates the value for that key before touching the database.
import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from './settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { InvalidSettingValueException, SettingNotFoundException } from '../exceptions/index.js';

function build(affected = 1) {
    const rawRepo = {
        update:  vi.fn().mockResolvedValue({ affected }),
        find:    vi.fn().mockResolvedValue([]),
        findOne: vi.fn().mockResolvedValue({ key: 'k', value: '10', description: null, updatedAt: new Date() }),
    };
    return { service: new SettingsService(rawRepo as any), rawRepo };
}

describe('SettingsService.update', () => {
    it('an out-of-range value is a 400 INVALID_SETTING_VALUE and nothing is written or cached', async () => {
        const { service, rawRepo } = build();

        await expect(service.update(SettingDto, 'session_inactivity_minutes', '-5')).rejects.toThrow(InvalidSettingValueException);
        await expect(service.update(SettingDto, 'max_failed_login_attempts', 'abc')).rejects.toThrow(InvalidSettingValueException);

        expect(rawRepo.update).not.toHaveBeenCalled();
        expect(service.getNumber('session_inactivity_minutes', 30)).toBe(30); // cache untouched
    });

    it('the error names the key and the accepted range', async () => {
        const { service } = build();

        await expect(service.update(SettingDto, 'sla_alert_threshold_pct', '150')).rejects.toMatchObject({
            response: { error: 'INVALID_SETTING_VALUE', message: 'sla_alert_threshold_pct must be a whole number of percent from 1 to 100.' },
        });
    });

    it('a valid value is saved and the cache is refreshed immediately', async () => {
        const { service, rawRepo } = build();

        await service.update(SettingDto, 'session_inactivity_minutes', '45');

        expect(rawRepo.update).toHaveBeenCalledWith('session_inactivity_minutes', { value: '45' });
        expect(service.getNumber('session_inactivity_minutes', 30)).toBe(45);
    });

    it('an unknown key is still 404 (and an invalid value for it is not checked)', async () => {
        const { service } = build(0);

        await expect(service.update(SettingDto, 'no_such_key', 'whatever')).rejects.toThrow(SettingNotFoundException);
    });
});
