import { describe, expect, it } from 'vitest';
import type { ComplaintCaseRow } from './case-quality.js';
import { paginate, sortById, toCaseItems } from './quality-tables.js';

const NOW = new Date('2026-11-24T12:00:00Z');
const row = (caseId: number, overrides: Partial<ComplaintCaseRow> = {}): ComplaintCaseRow => ({
    caseId, dispatchId: caseId * 10, reasonCode: 'DAMAGED', investigationStatus: 'received',
    openedAt: new Date('2026-11-24T10:00:00Z'), investigationStartedAt: null, decidedAt: null, ...overrides,
});

describe('paginate', () => {
    const items = [1, 2, 3, 4, 5];
    it('cuts the page and reports total and pages', () => {
        expect(paginate(items, 2, 2)).toEqual({ data: [3, 4], meta: { page: 2, limit: 2, pages: 3, total: 5 } });
    });
    it('zero results: empty page, zero pages', () => {
        expect(paginate([], 1, 10)).toEqual({ data: [], meta: { page: 1, limit: 10, pages: 0, total: 0 } });
    });
    it('one result fits one page; a page past the end is empty, not an error', () => {
        expect(paginate([7], 1, 10)).toEqual({ data: [7], meta: { page: 1, limit: 10, pages: 1, total: 1 } });
        expect(paginate(items, 9, 2).data).toEqual([]);
    });
});

describe('sortById', () => {
    it('orders by id both ways without touching the input', () => {
        const input = [{ id: 2 }, { id: 3 }, { id: 1 }];
        expect(sortById(input, (i) => i.id, 'asc').map((i) => i.id)).toEqual([1, 2, 3]);
        expect(sortById(input, (i) => i.id, 'desc').map((i) => i.id)).toEqual([3, 2, 1]);
        expect(input.map((i) => i.id)).toEqual([2, 3, 1]);
    });
});

describe('toCaseItems', () => {
    it('one row per case, open ones with their age, decided ones without', () => {
        const items = toCaseItems([row(1), row(1), row(2, { decidedAt: new Date('2026-11-24T11:00:00Z'), investigationStartedAt: new Date('2026-11-24T10:30:00Z') })], NOW, 'asc');
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ caseId: 1, open: true, ageMinutes: 120, decidedAt: null });
        expect(items[1]).toMatchObject({ caseId: 2, open: false, ageMinutes: null, decidedAt: '2026-11-24T11:00:00.000Z' });
    });
    it('exposes no personal data or evidence: only ids, codes, state and times', () => {
        expect(Object.keys(toCaseItems([row(1)], NOW, 'asc')[0]).sort()).toEqual([
            'ageMinutes', 'caseId', 'decidedAt', 'dispatchId', 'investigationStartedAt', 'investigationStatus', 'open', 'openedAt', 'reasonCode',
        ]);
    });
});
