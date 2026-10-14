import { describe, expect, it } from 'vitest';
import {
    loadPlanningSettings,
    parsePlanningSettings,
    REQUIRED_PLANNING_KEYS,
    type RawSettings,
} from './planning-settings.js';

const complete: RawSettings = {
    stop_service_minutes: '15',
    planning_margin_pct: '20',
    plan_working_days: '1,2,3,4,5',
    plan_non_working_dates: '2026-12-25',
    plan_min_orders_per_route: '3',
    service_min_operating_days: '2',
    service_max_operating_days: '3',
    route_cutoff_time: '15:00',
    promise_response_window_minutes: '720',
    slot_duration_minutes: '120',
    morning_window_start: '09:00',
    morning_window_end: '13:00',
    afternoon_window_start: '14:00',
    afternoon_window_end: '18:00',
    delivery_window_start: '08:00',
    delivery_window_end: '20:00',
};

describe('parsePlanningSettings', () => {
    it('reads every key into typed values', () => {
        const result = parsePlanningSettings(complete);

        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual([]);
        expect(result.values).toMatchObject({
            stopServiceMinutes: 15,
            planningMarginPct: 20,
            slotDurationMinutes: 120,
            minOrdersPerRoute: 3,
            morningWindow: { start: '09:00', end: '13:00' },
            afternoonWindow: { start: '14:00', end: '18:00' },
            promiseRules: {
                minOperatingDays: 2,
                maxOperatingDays: 3,
                routeCutoffTime: '15:00',
                promiseResponseWindowMinutes: 720,
            },
        });
        expect([...result.values!.calendar.workingWeekdays]).toEqual([1, 2, 3, 4, 5]);
        expect([...result.values!.calendar.nonWorkingDates]).toEqual(['2026-12-25']);
    });

    describe('blocks the generator', () => {
        it.each(REQUIRED_PLANNING_KEYS)('when %s is empty (as a fresh database seeds the unmeasured ones)', (key) => {
            const result = parsePlanningSettings({ ...complete, [key]: '' });

            expect(result.ok).toBe(false);
            expect(result.values).toBeNull();
            expect(result.missingKeys).toEqual([key]);
        });

        it.each(REQUIRED_PLANNING_KEYS)('when %s is absent', (key) => {
            const raw = { ...complete };
            delete raw[key];

            expect(parsePlanningSettings(raw).missingKeys).toEqual([key]);
        });

        it('reports every missing key at once', () => {
            const result = parsePlanningSettings({ ...complete, stop_service_minutes: '', planning_margin_pct: '' });

            expect(result.missingKeys).toEqual(['stop_service_minutes', 'planning_margin_pct']);
        });

        it('treats a blank (spaces only) value as missing', () => {
            expect(parsePlanningSettings({ ...complete, stop_service_minutes: '  ' }).missingKeys)
                .toEqual(['stop_service_minutes']);
        });

        it.each([
            ['stop_service_minutes', 'fifteen'],
            ['planning_margin_pct', '150'],
            ['plan_working_days', '1,9'],
            ['route_cutoff_time', '25:00'],
            ['plan_non_working_dates', '2026-02-30'],
            ['plan_min_orders_per_route', '0'],
        ])('when %s holds an invalid value %j', (key, value) => {
            const result = parsePlanningSettings({ ...complete, [key]: value });

            expect(result.ok).toBe(false);
            expect(result.invalidKeys).toEqual([key]);
            expect(result.missingKeys).toEqual([]);
        });

        it('when D_max is before D_min', () => {
            const result = parsePlanningSettings({
                ...complete, service_min_operating_days: '3', service_max_operating_days: '2',
            });

            expect(result.ok).toBe(false);
            expect(result.configurationProblem).toContain('service_max_operating_days');
        });

        it('when the morning window ends after the afternoon one starts', () => {
            const result = parsePlanningSettings({ ...complete, morning_window_end: '15:00' });

            expect(result.ok).toBe(false);
            expect(result.configurationProblem).toContain('morning_window_end');
        });

        it('when a route window is outside the delivery window', () => {
            const result = parsePlanningSettings({ ...complete, afternoon_window_end: '21:00' });

            expect(result.ok).toBe(false);
            expect(result.configurationProblem).toContain('afternoon_window_start');
        });
    });

    describe('only warns', () => {
        it('when there are no holidays configured, and assumes none', () => {
            const result = parsePlanningSettings({ ...complete, plan_non_working_dates: '' });

            expect(result.ok).toBe(true);
            expect(result.warnings).toEqual(['holidays_not_configured']);
            expect(result.values!.calendar.nonWorkingDates.size).toBe(0);
        });

        it('treats an absent plan_min_orders_per_route as no minimum, never as a block', () => {
            const raw = { ...complete };
            delete raw.plan_min_orders_per_route;

            const result = parsePlanningSettings(raw);

            expect(result.ok).toBe(true);
            expect(result.values!.minOrdersPerRoute).toBeNull();
        });
    });
});

describe('loadPlanningSettings', () => {
    it('reads every key by name and turns a missing one into the empty fallback', async () => {
        const asked: string[] = [];
        const reader = {
            getString: async (key: string, fallback: string) => {
                asked.push(key);
                return key === 'stop_service_minutes' ? fallback : (complete[key] ?? fallback);
            },
        };

        const result = await loadPlanningSettings(reader);

        expect(result.ok).toBe(false);
        expect(result.missingKeys).toEqual(['stop_service_minutes']);
        expect(asked).toEqual(expect.arrayContaining([...REQUIRED_PLANNING_KEYS, 'plan_non_working_dates', 'plan_min_orders_per_route']));
    });

    it('is ready to run when every key answers', async () => {
        const result = await loadPlanningSettings({ getString: async (key, fallback) => complete[key] ?? fallback });

        expect(result.ok).toBe(true);
    });
});
