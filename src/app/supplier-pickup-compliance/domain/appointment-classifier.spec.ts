import { describe, expect, it } from 'vitest';
import { AppointmentCategory, classifyAppointment, type AppointmentFacts } from './appointment-classifier.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const at = (iso: string) => new Date(iso);

const facts = (overrides: Partial<AppointmentFacts> = {}): AppointmentFacts => ({
    status: 'scheduled',
    windowStart: at('2026-11-18T14:00:00Z'),
    windowEnd: at('2026-11-18T16:00:00Z'),
    custodyReceivedAt: null,
    ...overrides,
});

describe('classifyAppointment', () => {
    it('a future appointment is pending and out of the rate', () => {
        const future = { windowStart: at('2026-11-21T14:00:00Z'), windowEnd: at('2026-11-21T16:00:00Z') };
        expect(classifyAppointment(facts(future), NOW)).toBe(AppointmentCategory.PENDING_NOT_DUE);
    });

    it('a future appointment already collected early is still pending: only expired ones are measured', () => {
        const early = { windowEnd: at('2026-11-21T16:00:00Z'), windowStart: at('2026-11-21T14:00:00Z'), custodyReceivedAt: at('2026-11-20T10:00:00Z'), status: 'picked_up_in_transit' };
        expect(classifyAppointment(facts(early), NOW)).toBe(AppointmentCategory.PENDING_NOT_DUE);
    });

    it('an appointment ending exactly at the cut is not expired yet', () => {
        expect(classifyAppointment(facts({ windowEnd: NOW }), NOW)).toBe(AppointmentCategory.PENDING_NOT_DUE);
    });

    it('custody inside the window is on time, including the end instant and before the start', () => {
        const base = { status: 'picked_up_in_transit' };
        expect(classifyAppointment(facts({ ...base, custodyReceivedAt: at('2026-11-18T15:00:00Z') }), NOW)).toBe(AppointmentCategory.ON_TIME);
        expect(classifyAppointment(facts({ ...base, custodyReceivedAt: at('2026-11-18T16:00:00Z') }), NOW)).toBe(AppointmentCategory.ON_TIME);
        expect(classifyAppointment(facts({ ...base, custodyReceivedAt: at('2026-11-18T13:00:00Z') }), NOW)).toBe(AppointmentCategory.ON_TIME);
    });

    it('custody after the end of the window is late', () => {
        expect(classifyAppointment(facts({ status: 'delivered', custodyReceivedAt: at('2026-11-18T16:00:01Z') }), NOW)).toBe(AppointmentCategory.LATE);
    });

    it('failed statuses with no custody are failed', () => {
        expect(classifyAppointment(facts({ status: 'incident' }), NOW)).toBe(AppointmentCategory.FAILED);
        expect(classifyAppointment(facts({ status: 'not_delivered' }), NOW)).toBe(AppointmentCategory.FAILED);
    });

    it('an expired active appointment with no custody is an open overdue exception, not a completed pickup', () => {
        for (const status of ['scheduled', 'assigned', 'in_transit', 'pickup_scheduled']) {
            expect(classifyAppointment(facts({ status }), NOW)).toBe(AppointmentCategory.OPEN_OVERDUE);
        }
    });

    it('a collected status with no custody timestamp is N/D, never guessed', () => {
        for (const status of ['picked_up_in_transit', 'delivered', 'returned_to_warehouse']) {
            expect(classifyAppointment(facts({ status }), NOW)).toBe(AppointmentCategory.UNKNOWN_TIMING);
        }
    });

    it('cancelled wins over everything else', () => {
        expect(classifyAppointment(facts({ status: 'cancelled', custodyReceivedAt: at('2026-11-18T15:00:00Z') }), NOW)).toBe(AppointmentCategory.CANCELLED);
        expect(classifyAppointment(facts({ status: 'cancelled', windowStart: null, windowEnd: null }), NOW)).toBe(AppointmentCategory.CANCELLED);
    });

    it('a missing or inverted window has no valid appointment, even with custody', () => {
        expect(classifyAppointment(facts({ windowStart: null, windowEnd: null }), NOW)).toBe(AppointmentCategory.NO_VALID_APPOINTMENT);
        expect(classifyAppointment(facts({ windowStart: at('2026-11-18T16:00:00Z'), windowEnd: at('2026-11-18T14:00:00Z') }), NOW)).toBe(AppointmentCategory.NO_VALID_APPOINTMENT);
        expect(classifyAppointment(facts({ windowEnd: null, custodyReceivedAt: at('2026-11-18T15:00:00Z') }), NOW)).toBe(AppointmentCategory.NO_VALID_APPOINTMENT);
    });
});
