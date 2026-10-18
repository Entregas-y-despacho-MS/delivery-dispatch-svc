/**
 * The parameters of a route simulation, from the operational settings (ST-50.2; ST-224.1 reuses them).
 * Pure. One definition for everyone who simulates a route (the plan generator and the customer's
 * rescheduling), so a stop is judged feasible by the same rules wherever the question is asked.
 */
import { minutesOfDay } from './operating-calendar.js';
import type { PlanningSettings } from './planning-settings.js';
import type { SimParams, TravelSeconds } from './route-simulation.js';
import { buildTimeSlots } from './time-slots.js';

export function buildSimParams(settings: PlanningSettings, travelSeconds: TravelSeconds): SimParams {
    return {
        slots: buildTimeSlots(settings.morningWindow, settings.afternoonWindow, settings.slotDurationMinutes),
        routeStartMinute: minutesOfDay(settings.morningWindow.start),
        routeEndMinute: minutesOfDay(settings.afternoonWindow.end),
        serviceMinutes: settings.stopServiceMinutes,
        marginPct: settings.planningMarginPct,
        travelSeconds,
    };
}
