import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../entities/setting.entity.js';
import { InvalidSettingValueException, SettingNotFoundException, SettingsVersionException } from '../exceptions/index.js';
import { validateSettingConfiguration, validateSettingValue } from '../utils/setting-value.validator.js';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { SETTINGS_CACHE_KEY, SETTINGS_VERSION_KEY } from '../settings.constants.js';

type SettingsSnapshot = {
    version: number;
    settings: Setting[];
};

const CACHE_REFRESH_MS = 60_000;

@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SettingsService.name);
    private refreshTimer?: NodeJS.Timeout;

    constructor(
        @InjectRepository(Setting)
        private readonly rawRepo: Repository<Setting>,
        private readonly cache: CacheService,
    ) {
    }

    async onModuleInit(): Promise<void> {
        await this.refresh();
        this.refreshTimer = setInterval(() => void this.refresh(), CACHE_REFRESH_MS);
        this.refreshTimer.unref?.();
    }

    onModuleDestroy(): void {
        clearInterval(this.refreshTimer);
    }

    async refresh(): Promise<void> {
        const settings = await this.rawRepo.find({ order: { key: 'ASC' } });
        await this.cacheSnapshot(settings);
    }

    async getString(key: string, fallback: string): Promise<string> {
        const setting = await this.readSetting(key);
        if (setting === null) {
            this.logger.warn(`Setting "${key}" not found, using fallback "${fallback}".`);
            return fallback;
        }
        return setting;
    }

    async getNumber(key: string, fallback: number): Promise<number> {
        const value = await this.readSetting(key);
        const parsed = value !== null && value.trim() !== '' ? Number(value) : NaN;
        if (!Number.isFinite(parsed)) {
            this.logger.warn(`Setting "${key}" is missing or not a number, using fallback ${fallback}.`);
            return fallback;
        }
        return parsed;
    }

    async getVersion(): Promise<number> {
        const snapshot = await this.readSnapshot();
        if (snapshot) return snapshot.version;

        const setting = await this.rawRepo.findOneBy({ key: SETTINGS_VERSION_KEY });
        if (!setting) return 0;
        if (!/^\d+$/.test(setting.value)) throw new SettingsVersionException();
        const version = Number(setting.value);
        if (!Number.isSafeInteger(version)) throw new SettingsVersionException();
        return version;
    }

    async findAll<T extends object>(dto: new () => T): Promise<T[]> {
        const snapshot = await this.readSnapshot();
        const settings = snapshot?.settings ?? await this.loadSettings();
        return this.toDtos(dto, settings.filter(({ key }) => key !== SETTINGS_VERSION_KEY));
    }

    async update<T extends object>(returnDto: new () => T, key: string, value: string): Promise<T> {
        if (key === SETTINGS_VERSION_KEY) {
            throw new InvalidSettingValueException(`${SETTINGS_VERSION_KEY} is managed by the service and cannot be changed.`);
        }

        const result = await this.rawRepo.manager.transaction(async (manager) => {
            const repository = manager.getRepository(Setting);
            const settings = await repository.find({
                order: { key: 'ASC' },
                lock:  { mode: 'pessimistic_write' },
            });
            const current = settings.find((setting) => setting.key === key);
            if (!current) throw new SettingNotFoundException();

            const valueProblem = validateSettingValue(key, value);
            if (valueProblem) throw new InvalidSettingValueException(valueProblem);

            const values = Object.fromEntries(settings
                .filter((setting) => setting.key !== SETTINGS_VERSION_KEY)
                .map((setting) => [setting.key, setting.value]));
            values[key] = value;
            const configurationProblem = validateSettingConfiguration(values);
            if (configurationProblem) throw new InvalidSettingValueException(configurationProblem);

            const versionSetting = settings.find((setting) => setting.key === SETTINGS_VERSION_KEY);
            if (versionSetting && !/^\d+$/.test(versionSetting.value)) throw new SettingsVersionException();

            await repository.update(key, { value });
            const version = Number(versionSetting?.value ?? '0') + 1;
            if (!Number.isSafeInteger(version)) throw new SettingsVersionException();
            if (!versionSetting) {
                await repository.insert({
                    key:         SETTINGS_VERSION_KEY,
                    value:       String(version),
                    description: 'Internal monotonically increasing version for operational settings.',
                });
            }
            await repository.update(SETTINGS_VERSION_KEY, { value: String(version) });

            return {
                version,
                settings: await repository.find({ order: { key: 'ASC' } }),
            };
        });

        await this.cacheSnapshot(result.settings, result.version);
        const updated = result.settings.find((setting) => setting.key === key)!;
        return this.toDto(returnDto, updated);
    }

    private async readSetting(key: string): Promise<string | null> {
        const snapshot = await this.readSnapshot();
        const cachedSetting = snapshot?.settings.find((setting) => setting.key === key);
        if (cachedSetting) return cachedSetting.value;

        const setting = await this.rawRepo.findOneBy({ key });
        if (!setting) return null;
        await this.refreshAfterCacheMiss();
        return setting.value;
    }

    private async readSnapshot(): Promise<SettingsSnapshot | null> {
        try {
            const cached = await this.cache.get(SETTINGS_CACHE_KEY);
            if (!cached) return null;
            const parsed = JSON.parse(cached) as SettingsSnapshot;
            if (!Number.isSafeInteger(parsed.version) || !Array.isArray(parsed.settings)) return null;
            return {
                version: parsed.version,
                settings: parsed.settings.map((setting) => ({
                    ...setting,
                    updatedAt: new Date(setting.updatedAt),
                })),
            };
        } catch (error) {
            if (!(error instanceof CacheUnavailableException)) this.logger.warn('The settings cache is invalid; loading from PostgreSQL.');
            return null;
        }
    }

    private async loadSettings(): Promise<Setting[]> {
        const settings = await this.rawRepo.find({ order: { key: 'ASC' } });
        await this.cacheSnapshot(settings);
        return settings;
    }

    private async refreshAfterCacheMiss(): Promise<void> {
        const settings = await this.rawRepo.find({ order: { key: 'ASC' } });
        await this.cacheSnapshot(settings);
    }

    private async cacheSnapshot(settings: Setting[], knownVersion?: number): Promise<void> {
        const versionSetting = settings.find(({ key }) => key === SETTINGS_VERSION_KEY);
        const version = knownVersion ?? (versionSetting ? (/^\d+$/.test(versionSetting.value) ? Number(versionSetting.value) : null) : 0);
        if (version === null) return;
        try {
            await this.cache.setIfNewer(SETTINGS_CACHE_KEY, version, JSON.stringify({ version, settings } satisfies SettingsSnapshot));
        } catch (error) {
            if (!(error instanceof CacheUnavailableException)) this.logger.warn('Could not update the settings cache.');
        }
    }

    private toDtos<T extends object>(dto: new () => T, settings: Setting[]): T[] {
        return settings.map((setting) => this.toDto(dto, setting));
    }

    private toDto<T extends object>(dto: new () => T, setting: Setting): T {
        return Object.assign(new dto(), setting);
    }
}
