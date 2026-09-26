import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../entities/setting.entity.js';
import { DtoRepository } from '../../../shared/orm/index.js';
import { SettingNotFoundException, InvalidSettingValueException } from '../exceptions/index.js';
import { validateSettingValue } from '../utils/setting-value.validator.js';

// Refreshes the in-memory cache periodically as a safety net for changes made directly in the
// DB (outside update()) — update() itself refreshes its own key immediately, no need to wait.
// 60s, not longer: the query is `SELECT * FROM settings` over ~a dozen rows (microseconds), so a
// short interval costs nothing and keeps that safety-net window tight. See decisions.md,
// 2026-09-19, for why this is a poll-and-replace cache rather than lazy per-key fetch.
const CACHE_REFRESH_MS = 60_000;

/**
 * Business-tunable config, backed by the `settings` table (key/value) — not env vars. Read
 * constantly (e.g. every login), so values are cached in memory instead of hitting the DB on
 * every read. See .claude/rules/settings.md.
 */
@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SettingsService.name);
    private readonly repo: DtoRepository<Setting>;
    private cache = new Map<string, string>();
    private refreshTimer?: NodeJS.Timeout;

    constructor(
        @InjectRepository(Setting)
        private readonly rawRepo: Repository<Setting>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    async onModuleInit(): Promise<void> {
        await this.refresh();
        this.refreshTimer = setInterval(() => void this.refresh(), CACHE_REFRESH_MS);
        // Don't hold the process open just for this timer.
        this.refreshTimer.unref?.();
    }

    onModuleDestroy(): void {
        clearInterval(this.refreshTimer);
    }

    async refresh(): Promise<void> {
        const rows = await this.rawRepo.find();
        this.cache = new Map(rows.map((row) => [row.key, row.value]));
    }

    getString(key: string, fallback: string): string {
        const value = this.cache.get(key);
        if (value === undefined) {
            this.logger.warn(`Setting "${key}" not found in cache, using fallback "${fallback}".`);
            return fallback;
        }
        return value;
    }

    getNumber(key: string, fallback: number): number {
        const value = this.cache.get(key);
        const parsed = value !== undefined ? Number(value) : NaN;
        if (Number.isNaN(parsed)) {
            this.logger.warn(`Setting "${key}" is missing or not a number, using fallback ${fallback}.`);
            return fallback;
        }
        return parsed;
    }

    async findAll<T>(dto: new () => T): Promise<T[]> {
        return this.repo.find({ dto, order: { key: 'ASC' } });
    }

    async update<T>(returnDto: new () => T, key: string, value: string): Promise<T> {
        const problem = validateSettingValue(key, value);
        if (problem) throw new InvalidSettingValueException(problem);

        const result = await this.rawRepo.update(key, { value });
        if (result.affected === 0) throw new SettingNotFoundException();

        this.cache.set(key, value);

        const updated = await new DtoRepository(this.rawRepo).findOne({ dto: returnDto, where: { key } });
        return updated!;
    }
}
