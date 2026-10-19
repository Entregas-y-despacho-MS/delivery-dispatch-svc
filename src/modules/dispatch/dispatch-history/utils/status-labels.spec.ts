import { describe, expect, it } from 'vitest';
import { terminalStatusLabel } from './status-labels.js';
import { TERMINAL_DISPATCH_STATUSES } from '../../dispatches/utils/terminal-statuses.js';

describe('terminalStatusLabel', () => {
    it.each([
        ['delivered', 'Entregado'],
        ['not_delivered', 'No entregado'],
        ['returned', 'Devuelto'],
        ['returned_to_warehouse', 'Devuelto a almacén'],
        ['cancelled', 'Cancelado'],
    ])('shows %s as «%s»', (status, label) => {
        expect(terminalStatusLabel(status)).toBe(label);
    });

    it('has a label for every final status, so a new one cannot reach the file as a bare code', () => {
        for (const status of TERMINAL_DISPATCH_STATUSES) {
            expect(terminalStatusLabel(status)).not.toBe(status);
        }
    });

    it('falls back to the code of an unknown status instead of leaving the cell empty', () => {
        expect(terminalStatusLabel('something_new')).toBe('something_new');
    });
});
