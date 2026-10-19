import { describe, expect, it } from 'vitest';
import { assertPlausibleIncidentTime, MAX_INCIDENT_AGE_MS, MAX_INCIDENT_FUTURE_MS, requiresIncidentObservations } from './incident-report.js';

describe('incident report rules', () => {
    const now = new Date('2026-10-19T12:00:00.000Z');

    it('accepts occurrence time within the 30-day offline window and existing 1-hour sync clock skew', () => {
        expect(() => assertPlausibleIncidentTime(new Date(now.getTime() - MAX_INCIDENT_AGE_MS), now)).not.toThrow();
        expect(() => assertPlausibleIncidentTime(new Date(now.getTime() + MAX_INCIDENT_FUTURE_MS), now)).not.toThrow();
    });

    it('rejects an implausibly old or future occurrence time', () => {
        expect(() => assertPlausibleIncidentTime(new Date(now.getTime() - MAX_INCIDENT_AGE_MS - 1), now)).toThrow(RangeError);
        expect(() => assertPlausibleIncidentTime(new Date(now.getTime() + MAX_INCIDENT_FUTURE_MS + 1), now)).toThrow(RangeError);
    });

    it('requires explanatory observations when the catalog label is Otro (accent and case insensitive)', () => {
        expect(requiresIncidentObservations('Otro')).toBe(true);
        expect(requiresIncidentObservations('OTRÓ')).toBe(true);
        expect(requiresIncidentObservations('Customer absent')).toBe(false);
    });
});
