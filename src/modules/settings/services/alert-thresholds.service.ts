import { Injectable } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { AlertThresholdsDto } from '../dto/alert-thresholds.dto.js';
import { UpdateAlertThresholdsDto } from '../dto/update-alert-thresholds.dto.js';
import { InvalidSettingValueException } from '../exceptions/index.js';
import { ALERT_THRESHOLD_KEYS } from '../settings.constants.js';

const FIELDS = Object.keys(ALERT_THRESHOLD_KEYS) as (keyof typeof ALERT_THRESHOLD_KEYS)[];

/** The three performance-alert thresholds (RF-A20), stored as ordinary settings. */
@Injectable()
export class AlertThresholdsService {
    constructor(private readonly settings: SettingsService) {}

    async get(): Promise<AlertThresholdsDto> {
        return this.toDto(await this.settings.findByKeys(SettingDto, FIELDS.map((field) => ALERT_THRESHOLD_KEYS[field])));
    }

    /** Validates and saves the three values together: one transaction, one version bump, cache replaced. */
    async update(dto: UpdateAlertThresholdsDto): Promise<AlertThresholdsDto> {
        const entries = Object.fromEntries(FIELDS.map((field) => [ALERT_THRESHOLD_KEYS[field], String(dto[field])]));
        return this.toDto(await this.settings.updateMany(SettingDto, entries));
    }

    private toDto(settings: SettingDto[]): AlertThresholdsDto {
        const result = new AlertThresholdsDto();
        FIELDS.forEach((field, index) => {
            const value = settings[index].value;
            if (!/^\d+$/.test(value)) throw new InvalidSettingValueException(`${ALERT_THRESHOLD_KEYS[field]} is not configured with a whole number.`);
            result[field] = Number(value);
        });
        result.updatedAt = new Date(Math.max(...settings.map(({ updatedAt }) => new Date(updatedAt).getTime())));
        return result;
    }
}
