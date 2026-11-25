import type { ComplaintCaseRow } from './case-quality.js';

/**
 * The two tables of Dashboard 4 (ST-300.2): the complaint cases and the dispatches, each one apart so a case is never counted as a
 * dispatch. Plain rows with no personal data (no customer, address, findings or evidence): only ids, codes, states and times.
 */
export type TableOrder = 'asc' | 'desc';

export interface Page<T> {
    data: T[];
    meta: { page: number; limit: number; pages: number; total: number };
}

export interface QualityCaseItem {
    caseId: number;
    dispatchId: number;
    reasonCode: string;
    investigationStatus: string;
    openedAt: string;
    investigationStartedAt: string | null;
    decidedAt: string | null;
    /** Not decided yet. */
    open: boolean;
    /** Minutes since it was opened, only for an open case. */
    ageMinutes: number | null;
}

export interface QualityDispatchItem {
    dispatchId: number;
    /** Current status of the dispatch. */
    status: string;
    /** Valid attempts rebuilt for this dispatch; 0 with `reconstructable: false` means «cannot be told», not «no attempt». */
    attemptCount: number;
    attemptsWithIncidentCount: number;
    incidentEventCount: number;
    /** Its window was changed at least once. */
    rescheduled: boolean;
    reconstructable: boolean;
}

const MS_PER_MINUTE = 60_000;

/** Stable order: by the id of the row, ascending or descending; ties cannot exist (the id is unique in each table). */
export function sortById<T>(items: T[], idOf: (item: T) => number, order: TableOrder): T[] {
    const sign = order === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => sign * (idOf(a) - idOf(b)));
}

/** One page of an already filtered and ordered list. A page past the end is an empty page, never an error. */
export function paginate<T>(items: T[], page: number, limit: number): Page<T> {
    const start = (page - 1) * limit;
    return { data: items.slice(start, start + limit), meta: { page, limit, pages: Math.ceil(items.length / limit), total: items.length } };
}

/** One row per case (a repeated `caseId` counts once), the same deduplication the rate uses. */
export function toCaseItems(rows: ComplaintCaseRow[], now: Date, order: TableOrder): QualityCaseItem[] {
    const unique = new Map<number, ComplaintCaseRow>();
    for (const row of rows) if (!unique.has(row.caseId)) unique.set(row.caseId, row);
    const items = [...unique.values()].map((row): QualityCaseItem => {
        const open = row.decidedAt === null;
        return {
            caseId: row.caseId, dispatchId: row.dispatchId, reasonCode: row.reasonCode, investigationStatus: row.investigationStatus,
            openedAt: row.openedAt.toISOString(),
            investigationStartedAt: row.investigationStartedAt ? row.investigationStartedAt.toISOString() : null,
            decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
            open,
            ageMinutes: open ? Math.max(0, Math.floor((now.getTime() - row.openedAt.getTime()) / MS_PER_MINUTE)) : null,
        };
    });
    return sortById(items, (item) => item.caseId, order);
}
