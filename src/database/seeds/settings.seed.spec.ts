import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { seedOperationalSettings } from './settings.seed.js';
import { Setting } from '../../modules/settings/entities/setting.entity.js';
import { OPERATIONAL_SETTING_SEEDS, SETTINGS_VERSION_KEY } from '../../modules/settings/settings.constants.js';

describe('seedOperationalSettings', () => {
    it('inserts missing settings once and preserves existing values', async () => {
        const existing = new Set(['plan_horizon_days']);
        const insert = vi.fn(async ({ key }: { key: string }) => { existing.add(key); });
        const repository = {
            findOneBy: vi.fn(async ({ key }: { key: string }) => existing.has(key) ? { key, value: 'existing-value' } : null),
            insert,
        } as unknown as Repository<Setting>;

        await seedOperationalSettings(repository);
        await seedOperationalSettings(repository);

        expect(insert).toHaveBeenCalledTimes(OPERATIONAL_SETTING_SEEDS.length);
        expect(insert).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'plan_horizon_days' }));
        expect(existing.has(SETTINGS_VERSION_KEY)).toBe(true);
        expect(OPERATIONAL_SETTING_SEEDS.find(({ key }) => key === 'stop_service_minutes')?.value).toBe('');
        expect(OPERATIONAL_SETTING_SEEDS.find(({ key }) => key === 'planning_margin_pct')?.value).toBe('');
    });
});
