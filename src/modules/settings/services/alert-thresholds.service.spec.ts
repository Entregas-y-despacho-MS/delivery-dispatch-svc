import { describe, expect, it, vi } from 'vitest';
import { AlertThresholdsService } from './alert-thresholds.service.js';
import type { SettingsService } from './settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { InvalidSettingValueException } from '../exceptions/index.js';

const row = (key: string, value: string, updatedAt = '2026-11-05T10:00:00.000Z'): SettingDto =>
    Object.assign(new SettingDto(), { key, value, description: null, updatedAt: new Date(updatedAt) });

function build() {
    const settings = {
        findByKeys: vi.fn(async () => [
            row('sla_alert_min_on_time_pct', '90'),
            row('gps_stale_alert_minutes', '5', '2026-11-05T11:00:00.000Z'),
            row('driver_incident_alert_per_day', '3'),
        ]),
        updateMany: vi.fn(async (_dto: unknown, entries: Record<string, string>) =>
            Object.entries(entries).map(([key, value]) => row(key, value, '2026-11-05T12:00:00.000Z'))),
    };
    return { service: new AlertThresholdsService(settings as unknown as SettingsService), settings };
}

describe('AlertThresholdsService', () => {
    it('reads the three settings as numbers and reports the latest change', async () => {
        const { service, settings } = build();

        const result = await service.get();

        expect(settings.findByKeys).toHaveBeenCalledWith(SettingDto, ['sla_alert_min_on_time_pct', 'gps_stale_alert_minutes', 'driver_incident_alert_per_day']);
        expect(result).toMatchObject({ slaAlertMinOnTimePct: 90, gpsStaleAlertMinutes: 5, driverIncidentAlertPerDay: 3 });
        expect(result.updatedAt.toISOString()).toBe('2026-11-05T11:00:00.000Z');
    });

    it('saves the three values in a single updateMany call, as text', async () => {
        const { service, settings } = build();

        const result = await service.update({ slaAlertMinOnTimePct: 80, gpsStaleAlertMinutes: 10, driverIncidentAlertPerDay: 4 });

        expect(settings.updateMany).toHaveBeenCalledTimes(1);
        expect(settings.updateMany).toHaveBeenCalledWith(SettingDto, { sla_alert_min_on_time_pct: '80', gps_stale_alert_minutes: '10', driver_incident_alert_per_day: '4' });
        expect(result).toMatchObject({ slaAlertMinOnTimePct: 80, gpsStaleAlertMinutes: 10, driverIncidentAlertPerDay: 4 });
    });

    it('lets a validation failure of updateMany reach the caller', async () => {
        const { service, settings } = build();
        settings.updateMany.mockRejectedValueOnce(new InvalidSettingValueException('gps_stale_alert_minutes must be a whole number of minutes from 1 to 1440.'));

        await expect(service.update({ slaAlertMinOnTimePct: 80, gpsStaleAlertMinutes: 0, driverIncidentAlertPerDay: 4 })).rejects.toThrow(InvalidSettingValueException);
    });

    it('fails when a stored threshold is not a whole number', async () => {
        const { service, settings } = build();
        settings.findByKeys.mockResolvedValueOnce([row('sla_alert_min_on_time_pct', ''), row('gps_stale_alert_minutes', '5'), row('driver_incident_alert_per_day', '3')]);

        await expect(service.get()).rejects.toThrow(InvalidSettingValueException);
    });
});
