import type { Repository } from 'typeorm';
import { Setting } from '../../modules/settings/entities/setting.entity.js';
import { OPERATIONAL_SETTING_SEEDS, SETTINGS_VERSION_KEY } from '../../modules/settings/settings.constants.js';

export async function seedOperationalSettings(repository: Repository<Setting>): Promise<void> {
    const settings = [
        ...OPERATIONAL_SETTING_SEEDS,
        { key: SETTINGS_VERSION_KEY, value: '0', description: 'Internal monotonically increasing version for operational settings.' },
    ];

    for (const setting of settings) {
        const existing = await repository.findOneBy({ key: setting.key });
        if (existing) continue;
        try {
            await repository.insert(setting);
        } catch (error) {
            const code = (error as { driverError?: { code?: string } }).driverError?.code;
            if (code !== '23505') throw error;
        }
    }
}
