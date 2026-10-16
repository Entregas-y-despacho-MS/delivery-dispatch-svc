import { minutesOfDay } from '../../planning/domain/operating-calendar.js';
import type { PlanningSettings } from '../../planning/domain/planning-settings.js';
import type { SimParams, TravelSeconds } from '../../planning/domain/route-simulation.js';
import { buildTimeSlots } from '../../planning/domain/time-slots.js';

/** The route simulation of a day: the same parameters the generator used to promise the slots (ST-50.2). */
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
