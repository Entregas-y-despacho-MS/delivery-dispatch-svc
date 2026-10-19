import { OPERATING_TIME_ZONE } from '../../dispatches/utils/operating-date.util.js';

/** RFC 4180: comma-separated, CRLF line ends. */
export const CSV_SEPARATOR = ',';
export const CSV_LINE_END = '\r\n';
/** Lets Excel recognise the file as UTF-8 (without it accents show up broken). */
export const CSV_BOM = '﻿';

// A cell that starts with one of these is read as a formula by Excel and Sheets (CSV injection): the
// customer name comes from the origin system and a plate or a name can be typed by a person.
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
    return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: (string | number | null | undefined)[]): string {
    return cells.map(csvCell).join(CSV_SEPARATOR) + CSV_LINE_END;
}

const LOCAL_PARTS = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATING_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
});

/**
 * A moment as `YYYY-MM-DD HH:mm:ss` in Bolivia time (the operation's time zone), e.g. `2026-10-10 11:30:00`. Excel
 * and Sheets read this form as a date and time in any regional setting, so the column can be sorted and filtered;
 * with an ISO offset (`...T11:30:00-04:00`) they keep it as text.
 */
export function formatLocalDateTime(value: Date | null): string {
    if (!value || Number.isNaN(value.getTime())) return '';
    const parts = Object.fromEntries(LOCAL_PARTS.formatToParts(value).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
