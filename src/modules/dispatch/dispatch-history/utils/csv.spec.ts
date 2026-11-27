import { describe, expect, it } from 'vitest';
import { csvCell, csvLine, formatLocalDateTime } from './csv.js';

describe('csvCell', () => {
    it('leaves plain text as it is and null or undefined as an empty cell', () => {
        expect(csvCell('DSP-2026-00001')).toBe('DSP-2026-00001');
        expect(csvCell(null)).toBe('');
        expect(csvCell(undefined)).toBe('');
        expect(csvCell(7)).toBe('7');
    });

    it('quotes a cell with a comma, a quote or a line break and doubles the quotes', () => {
        expect(csvCell('Pérez, María')).toBe('"Pérez, María"');
        expect(csvCell('dijo "hola"')).toBe('"dijo ""hola"""');
        expect(csvCell('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
        expect(csvCell('línea 1\r\nlínea 2')).toBe('"línea 1\r\nlínea 2"');
    });

    it.each(['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])('neutralises the formula %j', (text) => {
        const cell = csvCell(text);

        expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    });

    it('does not touch a dash or an equals sign that is not at the start', () => {
        expect(csvCell('Av. 6 de Agosto - Sur')).toBe('Av. 6 de Agosto - Sur');
        expect(csvCell('a=b')).toBe('a=b');
    });

    it.each([
        ['x;=1+1', "x;'=1+1"],
        ['x;+1;-2;@SUM(A1)', "x;'+1;'-2;'@SUM(A1)"],
        ['x;\t=1+1', "x;'\t=1+1"],
        ['x;"=1+1', '"x;""\'=1+1"'],
        ['x;""=1+1', '"x;""""\'=1+1"'],
        ['uno\n=1+1', '"uno\n\'=1+1"'],
        ['uno\r\n=1+1', '"uno\r\n\'=1+1"'],
        ['x;\r=1+1', '"x;\r\'=1+1"'],
    ])('neutralises a formula that would start a cell for a reader that splits %j elsewhere', (text, expected) => {
        expect(csvCell(text)).toBe(expected);
    });

    it('does not touch a semicolon or a line break that is not followed by a formula', () => {
        expect(csvCell('norte; sur')).toBe('norte; sur');
        expect(csvCell('Calle 1;Av. 2 - Sur')).toBe('Calle 1;Av. 2 - Sur');
        expect(csvCell('línea 1\r\nlínea 2')).toBe('"línea 1\r\nlínea 2"');
    });
});

describe('csvLine', () => {
    it('joins the cells with commas and ends with CRLF', () => {
        expect(csvLine(['a', null, 'b,c', 3])).toBe('a,,"b,c",3\r\n');
    });
});

describe('formatLocalDateTime', () => {
    it('writes the moment as date and time in Bolivia time, in the form spreadsheets read as a date', () => {
        expect(formatLocalDateTime(new Date('2026-10-10T15:00:00.000Z'))).toBe('2026-10-10 11:00:00');
    });

    it('moves the day when UTC is already the next one', () => {
        expect(formatLocalDateTime(new Date('2040-03-11T03:30:00.000Z'))).toBe('2040-03-10 23:30:00');
    });

    it('writes midnight as 00, not 24', () => {
        expect(formatLocalDateTime(new Date('2040-03-11T04:00:00.000Z'))).toBe('2040-03-11 00:00:00');
    });

    it('is empty for a missing or invalid moment', () => {
        expect(formatLocalDateTime(null)).toBe('');
        expect(formatLocalDateTime(new Date('nope'))).toBe('');
    });
});
