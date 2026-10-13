/**
 * Pure schedule arithmetic for the scheduled tasks (ST-50.3). No Nest, no database, no clock of its
 * own: the caller passes the instant and the current value of the setting.
 *
 * A task is evaluated once per minute. It is "due" when the local (America/La_Paz) HH:mm of that
 * minute matches its schedule, so changing a setting takes effect on the next tick without redeploy.
 */

export const SCHEDULER_TIME_ZONE = 'America/La_Paz';

/** Fixed at the time of day given by the setting `settingKey` (`HH:mm`), e.g. `route_cutoff_time`. */
export type TimeSchedule = { kind: 'time'; settingKey: string };
/** Fixed at each time of the comma-separated list in the setting, e.g. `plan_generation_times`. */
export type TimesSchedule = { kind: 'times'; settingKey: string };
/** Every `minutes` minutes, aligned to local midnight (`15` → :00, :15, :30, :45). */
export type EveryMinutesSchedule = { kind: 'every-minutes'; minutes: number };

export type TaskSchedule = TimeSchedule | TimesSchedule | EveryMinutesSchedule;

export type ScheduleEvaluation = 'due' | 'not-due' | 'invalid';

export interface LocalMoment {
    /** `YYYY-MM-DD` in the scheduler time zone. */
    date: string;
    /** `HH:mm` in the scheduler time zone. */
    time: string;
    minuteOfDay: number;
}

const MINUTES_PER_DAY = 24 * 60;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The minute (truncated) that `instant` falls in, as local date and time of day. */
export function toLocalMoment(instant: Date, timeZone: string = SCHEDULER_TIME_ZONE): LocalMoment {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year:      'numeric',
        month:     '2-digit',
        day:       '2-digit',
        hour:      '2-digit',
        minute:    '2-digit',
        hourCycle: 'h23',
    }).formatToParts(instant);
    const get = (type: string): string => parts.find((part) => part.type === type)!.value;

    const hour = get('hour');
    const minute = get('minute');
    return {
        date:        `${get('year')}-${get('month')}-${get('day')}`,
        time:        `${hour}:${minute}`,
        minuteOfDay: Number(hour) * 60 + Number(minute),
    };
}

/** `"08:30, 13:30"` → `["08:30", "13:30"]`; `null` when the value is empty or has an invalid item. */
export function parseTimeList(value: string | null | undefined): string[] | null {
    if (value === null || value === undefined) return null;
    const items = value.split(',').map((item) => item.trim());
    if (items.length === 0 || items.some((item) => !TIME.test(item))) return null;
    return items;
}

/** Whether the schedule is due at `moment`. `settingValue` is the current value of its setting, if any. */
export function evaluateSchedule(
    schedule: TaskSchedule,
    moment: LocalMoment,
    settingValue: string | null,
): ScheduleEvaluation {
    if (schedule.kind === 'every-minutes') {
        const { minutes } = schedule;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MINUTES_PER_DAY) return 'invalid';
        return moment.minuteOfDay % minutes === 0 ? 'due' : 'not-due';
    }

    const times = parseTimeList(settingValue);
    if (times === null) return 'invalid';
    if (schedule.kind === 'time' && times.length !== 1) return 'invalid';
    return times.includes(moment.time) ? 'due' : 'not-due';
}

/**
 * Identifies one occurrence of a task (`route-cutoff@2026-10-13T15:00`). Two instances evaluating the
 * same minute produce the same key, which is what lets only one of them run it.
 */
export function occurrenceKey(taskName: string, moment: LocalMoment): string {
    return `${taskName}@${moment.date}T${moment.time}`;
}
