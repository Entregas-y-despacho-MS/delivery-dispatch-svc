// ST-71.3: safety and fidelity of the audit export, GET /audit/admin-events/export (RF-A38).
//
// How it differs from admin-audit-export.e2e-spec.ts: that suite compares the ids of the CSV with the search, covers one
// formula, the rejected PDF over the maximum, the 403 per role and the audit of the export; of the PDF it only checks
// that the bytes start with %PDF. This one:
//   - parses the CSV as RFC 4180 and compares every cell with the JSON of the search, per filter, order and role;
//   - reads the text of the real PDF back, assigns each word to its column and compares every cell, checks that nothing
//     leaves the page and that the header repeats, also with the 12 columns of root and unbreakable long values;
//   - resolves by hand what accents, separators, line breaks and each formula prefix must look like in the raw file;
//   - exports events produced by real requests, including a formula planted without a token;
//   - checks both sides of both row maximums, accounts that lose the permission after their token was issued, and that
//     a failed or concurrent render never hands out a file, or a detail, that does not belong to the caller.
//
// The global rate limit (100 requests a minute per IP) is raised before the app is imported: every request here comes
// from the same address and the limit is not what this suite checks.
//
// Needs `pdftotext` (poppler) on the PATH to read the PDF. It deletes rows of an append-only table, so run it against a
// disposable database (postgres:18-alpine). Inserted events live in windows of March 2019, where nothing else writes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { PdfPort } from '../src/plugins/pdf/pdf.port.js';
import { PdfGenerationException } from '../src/plugins/pdf/exceptions/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';

vi.hoisted(() => { process.env.THROTTLE_LIMIT = '100000'; });

type Who = 'admin' | 'coordinator' | 'supervisor' | 'driver' | 'root';
type Query = Record<string, string | number>;
interface SearchEvent {
    eventId: string; occurredAt: string; actorId: number | null; actorRole: string | null; action: string;
    entityType: string | null; entityId: string | null; result: string; statusCode: number | null; correlationId: string;
    ip?: string | null; metadata?: Record<string, unknown>;
}

const COLUMNS = [
    'Fecha y hora', 'Id del evento', 'Id del actor', 'Rol del actor', 'Acción', 'Tipo de entidad', 'Id de la entidad',
    'Resultado', 'Código HTTP', 'Correlación',
];
const ROOT_COLUMNS = [...COLUMNS, 'Dirección IP', 'Campos declarados'];
const RESULT_ES: Record<string, string> = { success: 'Exitoso', denied: 'Denegado', failed: 'Fallido' };
const FORMULA_START = /^[=+\-@\t\r]/;
/** The same starts inside a value, where a reader that splits on `;` or on lines would open a cell. */
const guardInner = (text: string) => text.replace(/([;\r\n]"*)([=+\-@\t])/g, "$1'$2");
/** Cells a spreadsheet splitting on `;` would see in the raw file, quotes in front of them dropped. */
const semicolonCells = (raw: string) => raw.replace(/^\uFEFF/, '').split(/[;\r\n]/).map((cell) => cell.replace(/^"+/, ''));

/** Bolivia is UTC-4 all year: computed here on its own, not with the formatter under test. */
const laPaz = (iso: string) => new Date(new Date(iso).getTime() - 4 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * What a file must show for an event of the search. The guard against formulas of the CSV is the only rewrite there is;
 * a PDF runs nothing, so it prints the value as it is stored.
 */
const expectedRow = (event: SearchEvent, root: boolean, format: 'csv' | 'pdf' = 'csv'): string[] => {
    const values: unknown[] = [
        laPaz(event.occurredAt), event.eventId, event.actorId, event.actorRole, event.action, event.entityType,
        event.entityId, RESULT_ES[event.result], event.statusCode, event.correlationId,
    ];
    if (root) values.push(event.ip, event.metadata ? JSON.stringify(event.metadata) : null);
    return values.map((value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return format === 'csv' ? guardInner(FORMULA_START.test(text) ? `'${text}` : text) : text;
    });
};

/** Strict RFC 4180 reader: a stray quote or an unclosed field means the file does not open as intended. */
function parseCsv(text: string): string[][] {
    const records: string[][] = [];
    let record: string[] = [];
    let i = 0;
    while (i < text.length) {
        let cell = '';
        if (text[i] === '"') {
            i++;
            for (;;) {
                if (i >= text.length) throw new Error('Unclosed quoted field');
                if (text[i] === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
                if (text[i] === '"') { i++; break; }
                cell += text[i++];
            }
        } else {
            while (i < text.length && text[i] !== ',' && !text.startsWith('\r\n', i)) {
                if (/["\r\n]/.test(text[i]!)) {
                    throw new Error(`Unquoted special character after ${JSON.stringify(cell)}`);
                }
                cell += text[i++];
            }
        }
        record.push(cell);
        if (text[i] === ',') { i++; continue; }
        if (!text.startsWith('\r\n', i)) throw new Error(`Expected a separator at ${i}`);
        i += 2;
        records.push(record);
        record = [];
    }
    return records;
}

const readCsv = (body: string) => {
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const records = parseCsv(body.slice(1));
    const headerAt = records.findIndex((record) => record[0] === COLUMNS[0]);
    return { all: records, context: records.slice(0, headerAt - 1), columns: records[headerAt]!, rows: records.slice(headerAt + 1) };
};

interface Word { x0: number; y0: number; x1: number; y1: number; text: string }
interface PdfPage { width: number; height: number; words: Word[] }

const unescapeXml = (text: string) => text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');

function pdfWords(pdf: Buffer): PdfPage[] {
    const dir = mkdtempSync(join(tmpdir(), 'audit-pdf-'));
    try {
        const file = join(dir, 'export.pdf');
        writeFileSync(file, pdf);
        const xml = execFileSync('pdftotext', ['-bbox', '-enc', 'UTF-8', file, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
        return [...xml.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)].map((page) => ({
            width: Number(page[1]),
            height: Number(page[2]),
            words: [...page[3]!.matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([\s\S]*?)<\/word>/g)]
                .map((w) => ({ x0: Number(w[1]), y0: Number(w[2]), x1: Number(w[3]), y1: Number(w[4]), text: unescapeXml(w[5]!) })),
        }));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** The 8 mm side margin of the paper, in points: no text may start before it or end after it. */
const SIDE = (8 / 25.4) * 72;
/** Wrapping splits a value anywhere, so cells are compared without white space. */
const squash = (text: string) => text.normalize('NFC').replace(/\s+/g, '');

/**
 * Where the columns of a page are. The layout is fixed, with columns of equal width, so the first words of the headers
 * of the first two columns ("Fecha", "Id") give where the text of the first column starts and how wide a column is.
 */
function tableGeometry(page: PdfPage) {
    for (const first of page.words.filter((word) => word.text === 'Fecha')) {
        const second = page.words.filter((word) => word.text === 'Id' && Math.abs(word.y0 - first.y0) < 1 && word.x0 > first.x0)
            .sort((a, b) => a.x0 - b.x0)[0];
        if (!second) continue;
        const width = second.x0 - first.x0;
        return {
            top: first.y0,
            width,
            column: (word: Word) => Math.floor((word.x0 - first.x0 + 1) / width),
            /** Whether the word ends before the text of the next column begins (cells have padding on both sides). */
            fits: (word: Word) => word.x1 <= first.x0 + (Math.floor((word.x0 - first.x0 + 1) / width) + 1) * width - 3,
        };
    }
    throw new Error('A page of the PDF has no table header');
}

/** The table of the PDF as a reader sees it: a row starts at the line of its date and ends where the next one starts. */
function readPdf(pdf: Buffer, columns: number) {
    const pages = pdfWords(pdf);
    const rows: string[][] = [];
    const headers: string[][] = [];
    const summary: string[] = [];
    for (const page of pages) {
        const { top: headerTop, column } = tableGeometry(page);
        const sorted = [...page.words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
        const tops = sorted.filter((word) => word.y0 > headerTop + 1 && column(word) === 0 && /^\d{4}-\d{2}-\d{2}$/.test(word.text)).map((word) => word.y0);
        const cellsBetween = (from: number, to: number) => Array.from({ length: columns }, (_, index) => squash(
            sorted.filter((word) => word.y0 >= from - 1 && word.y0 < to - 1 && column(word) === index).map((word) => word.text).join(''),
        ));
        // Above the table, line by line: each label of the header block is followed by its value.
        summary.push(squash(sorted.filter((word) => word.y0 < headerTop - 1).map((word) => word.text).join('')));
        headers.push(cellsBetween(headerTop, tops[0] ?? page.height));
        tops.forEach((top, index) => rows.push(cellsBetween(top, tops[index + 1] ?? page.height + 1)));
    }
    // A value wrapped inside a cell is whole again in `text`, so looking for something in it cannot miss it by a line break.
    const text = [...summary, ...[...headers, ...rows].map((cells) => cells.join('|'))].join('|');
    return { pages, rows, headers, text };
}

/** Every cell equals the search; under the action the PDF also prints its description, which is allowed after the name. */
function expectPdfRows(actual: string[][], events: SearchEvent[], root: boolean) {
    const expected = events.map((event) => expectedRow(event, root, 'pdf').map(squash));
    expect(actual).toHaveLength(expected.length);
    actual.forEach((row, index) => {
        const want = expected[index]!;
        expect(row[4]!.startsWith(want[4]!)).toBe(true);
        expect(row.filter((_, i) => i !== 4)).toEqual(want.filter((_, i) => i !== 4));
    });
}

const binary = (res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('audit export is safe and faithful (ST-71.3)', () => {
    const h = new AuditE2eHarness('auditsafe');
    const tokens = {} as Record<Who, string>;
    let sequence = 0;

    const window = { from: '2019-03-05T00:00:00-04:00', to: '2019-03-06T00:00:00-04:00' };
    const wideWindow = { from: '2019-03-07T00:00:00-04:00', to: '2019-03-08T00:00:00-04:00' };
    const uuid = (n: number) => `00000000-0000-4000-a713-${String(n).padStart(12, '0')}`;

    // Reference table, resolved by hand: [entity id as stored, exact text of its cell in the raw CSV].
    const HOSTILE: Array<[string, string, string]> = [
        ['equals', '=1+1', "'=1+1"],
        ['plus', '+59170000000', "'+59170000000"],
        ['minus', '-2+3', "'-2+3"],
        ['at', '@SUM(A1:A9)', "'@SUM(A1:A9)"],
        ['tab', '\t=1+1', "'\t=1+1"],
        ['carriage return', '\r=1+1', '"\'\r\'=1+1"'],
        ['formula with quotes and commas', '=HYPERLINK("http://x.test","ver")', '"\'=HYPERLINK(""http://x.test"",""ver"")"'],
        ['accents', 'Ñandú-áéíóú-ÜÇ', 'Ñandú-áéíóú-ÜÇ'],
        ['comma', 'norte,sur', '"norte,sur"'],
        ['quote', 'di"jo', '"di""jo"'],
        ['line feed', 'uno\ndos', '"uno\ndos"'],
        ['CRLF with a formula on the second line', 'uno\r\n=1+1', '"uno\r\n\'=1+1"'],
        ['a sign in the middle is data', 'a=b', 'a=b'],
        ['a quote already there', "'ya", "'ya"],
    ];
    const ACCENTED_METADATA = { zoneName: 'Peñón "Á", sur\nsegundo renglón', reason: '=cmd|calc' };

    const call = (path: string, token: string | null, query: Query = {}) => h.call('get', path, token).response.query(query);
    const exportFile = (token: string | null, format: 'csv' | 'pdf', query: Query) => {
        const test = call('/audit/admin-events/export', token, { ...window, format, ...query });
        // A rejection is JSON and must stay readable, so only a successful PDF is collected as bytes.
        return format === 'pdf' ? test.buffer(true).parse(binary as never) : test;
    };
    const csvOf = async (who: Who, query: Query = {}) => {
        const res = await exportFile(tokens[who], 'csv', query);
        expect(res.status).toBe(200);
        return { res, ...readCsv(res.text) };
    };
    const pdfOf = async (who: Who, query: Query = {}) => {
        const res = await exportFile(tokens[who], 'pdf', query);
        expect(res.status).toBe(200);
        return { res, ...readPdf(res.body as Buffer, who === 'root' ? ROOT_COLUMNS.length : COLUMNS.length) };
    };
    /** The oracle: what the screen lists, page by page. */
    const searchAll = async (who: Who, query: Query = {}): Promise<SearchEvent[]> => {
        const out: SearchEvent[] = [];
        for (let page = 1; ; page++) {
            const res = await call('/audit/admin-events', tokens[who], { ...window, ...query, page, limit: 100 });
            expect(res.status).toBe(200);
            out.push(...res.body.data);
            if (page >= res.body.meta.pages) {
                // The screen is the oracle of the file, so it must not offer the administrator more than the file may hold.
                if (who !== 'root') expect(out.filter((event) => 'ip' in event || 'metadata' in event)).toEqual([]);
                return out;
            }
        }
    };

    const insert = async (event: {
        at: string; actor?: number | null; role?: string | null; action?: string; type?: string; entityId?: string | null;
        result?: string; status?: number; correlation?: string; ip?: string | null; metadata?: object; id?: string;
    }) => {
        const n = ++sequence;
        await h.db.query(
            `INSERT INTO admin_audit_events (admin_audit_event_id, actor_user_id, actor_role, action, entity_type, entity_id, result, status_code, correlation_id, ip_address, metadata, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [event.id ?? uuid(n), event.actor === undefined ? h.users.admin.id : event.actor, event.role === undefined ? 'admin' : event.role,
                event.action ?? 'user.updated', event.type ?? 'user', event.entityId ?? null, event.result ?? 'success', event.status ?? 200,
                event.correlation ?? `${h.prefix}-row${n}`, event.ip ?? null, JSON.stringify(event.metadata ?? {}), event.at],
        );
    };

    const createUser = async (role: string, suffix: string) => {
        const username = `${h.prefix}-${suffix}`;
        const [{ user_id }] = await h.db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
            [h.roles[role], `E2E ${suffix}`, username, await hashPassword(h.password)],
        );
        return { id: user_id as number, token: await h.login(username, h.password) };
    };

    beforeAll(async () => {
        try {
            execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
        } catch {
            throw new Error('This suite reads the exported PDF with `pdftotext`: install poppler (brew install poppler / apt install poppler-utils).');
        }
        await h.start(['admin', 'coordinator', 'supervisor', 'driver']);
        // Listening once: concurrent requests of supertest would otherwise open and close the same server.
        await h.app.listen(0);
        const root = await createUser('root', 'root');
        for (const who of ['admin', 'coordinator', 'supervisor', 'driver'] as const) tokens[who] = h.users[who].token;
        tokens.root = root.token;

        for (const [index, [, entityId]] of HOSTILE.entries()) {
            await insert({
                at: `2019-03-05T10:${String(index).padStart(2, '0')}:00Z`, entityId,
                ip: '10.20.30.40', metadata: index === 0 ? ACCENTED_METADATA : { roleId: 3 },
            });
        }
        // Rows that tell the filters apart; the last two share the instant, so only the id orders them.
        await insert({ at: '2019-03-05T11:00:00Z', actor: h.users.coordinator.id, role: 'coordinator', action: 'setting.updated', type: 'setting', entityId: 'k', result: 'denied', status: 403, correlation: `${h.prefix}-wanted`, ip: '2001:db8::77' });
        await insert({ at: '2019-03-05T12:00:00Z', actor: null, role: null, action: 'user.deleted', entityId: '77', result: 'denied', status: 401 });
        await insert({ at: '2019-03-05T13:00:00Z', action: 'vehicle.changed', type: 'vehicle', entityId: '77', result: 'failed', status: 500 });
        await insert({ at: '2019-03-05T13:00:00Z', action: 'user.created', entityId: '78', status: 201 });

        // Wide and long: unbreakable values at the size of their columns, over enough rows for several pages.
        for (let i = 0; i < 60; i++) {
            await insert({
                at: new Date(Date.parse('2019-03-07T10:00:00Z') + i * 1000).toISOString(),
                action: 'route_batch.assignment_changed', type: 'route_batch',
                entityId: `${'W'.repeat(60)}${String(i).padStart(4, '0')}`,
                correlation: `${h.prefix}-${'M'.repeat(64 - h.prefix.length - 6)}${String(i).padStart(5, '0')}`,
                ip: '2001:0db8:85a3:1234:5678:8a2e:0370:7334',
                metadata: { driverId: 2147483647, reason: 'X'.repeat(120), last: `fin-${i}` },
            });
        }
    }, 120_000);

    afterAll(async () => {
        if (h.db?.isInitialized) {
            await h.db.query('DELETE FROM admin_audit_events WHERE correlation_id LIKE $1 OR actor_user_id IN (SELECT user_id FROM users WHERE username LIKE $1)', [`${h.prefix}-%`]);
        }
        await h.close();
    });

    describe('every exported cell is the one of the search', () => {
        const filters: Array<[string, () => Query, number]> = [
            ['no filter', () => ({}), 18],
            ['actorId', () => ({ actorId: h.users.coordinator.id }), 1],
            ['actorRole', () => ({ actorRole: 'coordinator' }), 1],
            ['action', () => ({ action: 'user.updated' }), 14],
            ['entityType', () => ({ entityType: 'user' }), 16],
            ['entityType and entityId', () => ({ entityType: 'vehicle', entityId: '77' }), 1],
            ['result', () => ({ result: 'denied' }), 2],
            ['correlationId', () => ({ correlationId: `${h.prefix}-wanted` }), 1],
            ['combined filters', () => ({ actorRole: 'admin', result: 'success', entityType: 'user' }), 15],
        ];

        describe.each(['admin', 'root'] as const)('as %s', (who) => {
            it.each(filters)('CSV, filtered by %s, in both orders', async (_name, query, count) => {
                for (const order of ['asc', 'desc'] as const) {
                    const events = await searchAll(who, { ...query(), order });
                    expect(events).toHaveLength(count);
                    const csv = await csvOf(who, { ...query(), order });
                    expect(csv.columns).toEqual(who === 'root' ? ROOT_COLUMNS : COLUMNS);
                    expect(csv.rows).toEqual(events.map((event) => expectedRow(event, who === 'root')));
                    expect(csv.context).toContainEqual(['Total de filas', String(count)]);
                }
            });

            it.each(filters)('PDF, filtered by %s', async (_name, query, count) => {
                const events = await searchAll(who, { ...query(), order: 'asc' });
                const pdf = await pdfOf(who, { ...query(), order: 'asc' });
                expectPdfRows(pdf.rows, events, who === 'root');
                expect(pdf.text).toContain(squash(`Total de filas${count}`));
            });
        });

        it('echoes every applied filter with its value, in the header of both files', async () => {
            const query = {
                actorId: h.users.coordinator.id, actorRole: 'coordinator', action: 'setting.updated', entityType: 'setting',
                entityId: 'k', result: 'denied', correlationId: `${h.prefix}-wanted`, order: 'asc',
            };
            const lines: [string, string][] = [
                ['Filtro: Id del actor', String(h.users.coordinator.id)], ['Filtro: Rol del actor', 'coordinator'],
                ['Filtro: Acción', 'setting.updated'], ['Filtro: Tipo de entidad', 'setting'], ['Filtro: Id de la entidad', 'k'],
                ['Filtro: Resultado', 'denied'], ['Filtro: Correlación', `${h.prefix}-wanted`], ['Filtro: Orden', 'Más antiguos primero'],
            ];
            const csv = await csvOf('admin', query);
            const pdf = await pdfOf('admin', query);
            for (const [label, value] of lines) {
                expect(csv.context).toContainEqual([label, value]);
                expect(pdf.text).toContain(squash(label + value));
            }
            for (const line of ['Período desde (incluido)2019-03-05 00:00:00', 'Período hasta (excluido)2019-03-06 00:00:00', 'Zona horariaAmerica/La_Paz']) {
                expect(pdf.text).toContain(squash(line));
            }
            expect(pdf.text).toMatch(/Generadoel\d{4}-\d{2}-\d{2}\d{2}:\d{2}:\d{2}/);
        });
    });

    describe('hostile and non-ASCII values', () => {
        it.each(HOSTILE)('%s: the raw cell is the one resolved by hand', async (_name, stored, raw) => {
            const index = HOSTILE.findIndex(([, value]) => value === stored);
            const { res } = await csvOf('admin', { order: 'asc' });
            // The cell sits between the entity type and the result.
            const line = `,${uuid(index + 1)},${h.users.admin.id},admin,user.updated,user,${raw},Exitoso,200,`;
            expect(res.text).toContain(line);
        });

        it('no cell of the whole file, header block included, starts like a formula', async () => {
            for (const who of ['admin', 'root'] as const) {
                const { all } = await csvOf(who);
                const dangerous = all.flat().filter((cell) => FORMULA_START.test(cell));
                expect(dangerous).toEqual([]);
            }
        });

        it('no cell starts like a formula for a reader that splits the file on semicolons either', async () => {
            for (const who of ['admin', 'root'] as const) {
                const { res } = await csvOf(who);
                expect(semicolonCells(res.text).filter((cell) => /^[=+\-@\t]/.test(cell))).toEqual([]);
            }
        });

        it('keeps one record per event: separators and line breaks inside a value never add a row or a column', async () => {
            const csv = await csvOf('root');
            expect(csv.rows).toHaveLength(18);
            expect(new Set(csv.rows.map((row) => row.length))).toEqual(new Set([ROOT_COLUMNS.length]));
        });

        it.each(HOSTILE.map(([name, value]) => [name, value]).filter(([, value]) => !/\s/.test(value!)))(
            '%s as a filter value is neutralized in the header too', async (_name, value) => {
                const csv = await csvOf('admin', { entityType: 'user', entityId: value! });
                expect(csv.context).toContainEqual(['Filtro: Id de la entidad', FORMULA_START.test(value!) ? `'${value}` : value!]);
                expect(csv.rows).toHaveLength(1);
            });

        it('is UTF-8 with a byte-order mark, and accents survive in bytes, in values, headers and root detail', async () => {
            const res = await exportFile(tokens.root, 'csv', {}).buffer(true).parse(binary as never);
            const bytes = res.body as Buffer;
            expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            expect(bytes.includes(Buffer.from('Ñandú-áéíóú-ÜÇ', 'utf8'))).toBe(true);
            // The decoder drops the mark, which `readCsv` expects.
            const csv = readCsv(`\uFEFF${text}`);
            const detail = csv.rows.find((row) => row[1] === uuid(1))![11]!;
            expect(JSON.parse(detail)).toEqual(ACCENTED_METADATA);
        });

        it('prints accents and markup in the PDF as the text they are', async () => {
            await insert({ at: '2019-03-06T10:00:00Z', entityId: '<img/src=x>&amp;</td>', metadata: { zoneName: '<b>Peñón</b>' } });
            const pdf = await pdfOf('root', { from: '2019-03-06T00:00:00-04:00', to: '2019-03-07T00:00:00-04:00' });
            expect(pdf.rows).toHaveLength(1);
            expect(pdf.rows[0]![6]).toBe('<img/src=x>&amp;</td>');
            expect(pdf.rows[0]![11]).toBe(squash('{"zoneName":"<b>Peñón</b>"}'));
            expect(pdf.headers[0]).toEqual(ROOT_COLUMNS.map(squash));
        });
    });

    describe('wide PDF', () => {
        it.each([['admin', COLUMNS], ['root', ROOT_COLUMNS]] as const)(
            'as %s: landscape, every column on every page, nothing off the page and no value cut', async (who, columns) => {
                const events = await searchAll(who, { ...wideWindow, order: 'asc' });
                expect(events).toHaveLength(60);
                const pdf = await pdfOf(who, { ...wideWindow, order: 'asc' });
                expect(pdf.pages.length).toBeGreaterThan(1);
                for (const page of pdf.pages) {
                    expect(page.width).toBeGreaterThan(page.height);
                    const outside = page.words.filter((word) => word.x0 < SIDE || word.x1 > page.width - SIDE || word.y0 < 0 || word.y1 > page.height);
                    expect(outside).toEqual([]);
                    // A long value wraps inside its column instead of running over the next one, and no column is lost.
                    const { top, fits, column } = tableGeometry(page);
                    const cells = page.words.filter((word) => word.y0 >= top - 1);
                    expect(cells.filter((word) => !fits(word))).toEqual([]);
                    expect(new Set(cells.map(column))).toEqual(new Set(columns.map((_, index) => index)));
                }
                expect(pdf.headers).toEqual(pdf.pages.map(() => columns.map(squash)));
                expectPdfRows(pdf.rows, events, who === 'root');
            });
    });

    describe('row maximums, on both sides', () => {
        // 10001 events one second apart: the end of the window, which is excluded, sets how many fall inside.
        const base = Date.parse('2019-03-09T04:00:00Z');
        const holding = (rows: number) => ({ from: '2019-03-09T00:00:00-04:00', to: new Date(base + (rows + 1) * 1000).toISOString() });
        const idsInOrder = async (rows: number): Promise<string[]> => (await h.db.query(
            `SELECT admin_audit_event_id AS id FROM admin_audit_events WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at DESC, admin_audit_event_id DESC`,
            [holding(rows).from, holding(rows).to],
        )).map((row: { id: string }) => row.id);

        beforeAll(async () => {
            await h.db.query(
                `INSERT INTO admin_audit_events (admin_audit_event_id, actor_user_id, actor_role, action, entity_type, entity_id, result, status_code, correlation_id, occurred_at)
                 SELECT gen_random_uuid(), $1, 'admin', 'user.updated', 'user', g::text, 'success', 200, $2 || '-lim' || g, $3::timestamptz + (g || ' seconds')::interval
                 FROM generate_series(1, 10001) g`,
                [h.users.admin.id, h.prefix, new Date(base).toISOString()],
            );
        }, 60_000);

        it.each([['csv', 10_000], ['pdf', 2_000]] as const)('%s with exactly %i rows holds all of them', async (format, max) => {
            const expected = await idsInOrder(max);
            expect(expected).toHaveLength(max);
            if (format === 'csv') {
                expect((await csvOf('admin', holding(max))).rows.map((row) => row[1])).toEqual(expected);
            } else {
                expect((await pdfOf('admin', holding(max))).rows.map((row) => row[1])).toEqual(expected);
            }
        }, 120_000);

        it.each([['csv', 10_000], ['pdf', 2_000]] as const)('%s with one row over %i sends no file and no row', async (format, max) => {
            const over = await idsInOrder(max + 1);
            expect(over).toHaveLength(max + 1);
            const res = await call('/audit/admin-events/export', tokens.admin, { ...holding(max + 1), format });
            expect(res.status).toBe(400);
            expect(res.headers['content-type']).toMatch(/json/);
            expect(res.headers['content-disposition']).toBeUndefined();
            expect(res.body.error).toBe('AUDIT_EXPORT_LIMIT_EXCEEDED');
            expect(res.body.message).toContain(`more than ${max} rows`);
            expect(Object.keys(res.body).sort()).toEqual(['error', 'message', 'path', 'statusCode', 'timestamp']);
            expect(over.some((id) => JSON.stringify(res.body).includes(id))).toBe(false);
        }, 60_000);

        it('counts the filtered result, not the window: a filter brings a rejected window back under the maximum', async () => {
            const csv = await csvOf('admin', { ...holding(10_001), entityType: 'user', entityId: '42' });
            expect(csv.rows.map((row) => row[6])).toEqual(['42']);
        });
    });

    describe('events produced by real requests', () => {
        const around = () => ({ from: new Date(Date.now() - 600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
        const strong = 'Passw0rd!Strong1';

        it('exports a creation and a denial as they happened, without the password, the email or the name', async () => {
            const body = (suffix: string) => ({
                fullName: `Persona Privada ${suffix}`, username: `${h.prefix}-${suffix}`, email: `${h.prefix}-${suffix}@privado.test`,
                password: strong, roleId: h.roles.driver,
            });
            const created = h.call('post', '/users', tokens.admin, body('real'));
            const createdRes = await created.response;
            expect(createdRes.status).toBe(201);
            const denied = h.call('post', '/users', tokens.coordinator, body('refused'));
            expect((await denied.response).status).toBe(403);

            const expected = [
                { correlationId: created.correlationId, cells: [String(h.users.admin.id), 'admin', 'user.created', 'user', String(createdRes.body.id), 'Exitoso', '201'] },
                { correlationId: denied.correlationId, cells: [String(h.users.coordinator.id), 'coordinator', 'user.created', 'user', '', 'Denegado', '403'] },
            ];
            for (const { correlationId, cells } of expected) {
                for (const who of ['admin', 'root'] as const) {
                    const csv = await csvOf(who, { ...around(), correlationId });
                    expect(csv.rows).toHaveLength(1);
                    expect(csv.rows[0]!.slice(2, 9)).toEqual(cells);
                    const pdf = await pdfOf(who, { ...around(), correlationId });
                    expectPdfRows(pdf.rows, await searchAll(who, { ...around(), correlationId }), who === 'root');
                    for (const file of [squash(csv.res.text), pdf.text]) {
                        for (const secret of [strong, '@privado.test', squash('Persona Privada'), tokens.admin, tokens.coordinator]) {
                            expect(file).not.toContain(secret);
                        }
                    }
                }
            }
        });

        // Anyone can write into the trail: a denied request keeps the id of its path, before any authentication.
        it('neutralizes a formula planted without a token through the path of a protected endpoint', async () => {
            const payload = '=HYPERLINK("http://x.test/"&A1,"ver")';
            const planted = h.call('delete', `/users/${encodeURIComponent(payload)}`, null);
            expect((await planted.response).status).toBe(401);
            expect((await h.eventsOf(planted.correlationId))[0]!.entity_id).toBe(payload);

            const csv = await csvOf('admin', { ...around(), correlationId: planted.correlationId });
            expect(csv.rows[0]![6]).toBe(`'${payload}`);
            expect(csv.all.flat().filter((cell) => FORMULA_START.test(cell))).toEqual([]);
        });

        it.each(['x;=1+1', 'x;"=1+1', 'x\n=1+1'])('neutralizes %j, planted without a token, for readers that split elsewhere', async (payload) => {
            const planted = h.call('delete', `/users/${encodeURIComponent(payload)}`, null);
            expect((await planted.response).status).toBe(401);
            expect((await h.eventsOf(planted.correlationId))[0]!.entity_id).toBe(payload);

            const csv = await csvOf('admin', { ...around(), correlationId: planted.correlationId });
            expect(csv.rows[0]![6]).toBe(payload.replace('=', "'="));
            expect(semicolonCells(csv.res.text).filter((cell) => /^[=+\-@\t]/.test(cell))).toEqual([]);
        });

        it('neutralizes a request id chosen by the client that starts with a sign', async () => {
            const correlationId = `-2.${h.prefix}`;
            try {
                const res = await request(h.app.getHttpServer()).delete(`/${h.api}/users/1`).set('X-Request-Id', correlationId);
                expect(res.status).toBe(401);
                const csv = await csvOf('admin', { ...around(), correlationId });
                expect(csv.rows[0]![9]).toBe(`'${correlationId}`);
                expect(csv.context).toContainEqual(['Filtro: Correlación', `'${correlationId}`]);
            } finally {
                await h.db.query('DELETE FROM admin_audit_events WHERE correlation_id = $1', [correlationId]);
            }
        });

        it('does not list an export inside its own file; the next one does', async () => {
            const reviewer = await createUser('admin', 'reviewer');
            const query = () => ({ ...around(), actorId: reviewer.id });
            const own = async () => {
                const { correlationId, response } = h.call('get', '/audit/admin-events/export', reviewer.token);
                const res = await response.query({ ...query(), format: 'csv' });
                expect(res.status).toBe(200);
                return { correlationId, rows: readCsv(res.text).rows };
            };
            const first = await own();
            expect(first.rows).toEqual([]);
            const second = await own();
            expect(second.rows.map((row) => [row[4], row[9]])).toEqual([['audit.exported', first.correlationId]]);
        });
    });

    describe('what a caller is not authorized to get', () => {
        const noRecords = (res: { status: number; headers: Record<string, string>; body: unknown; text?: string }) => {
            expect(res.headers['content-disposition']).toBeUndefined();
            expect(res.headers['content-type']).toMatch(/json/);
            expect(JSON.stringify(res.body)).not.toMatch(/00000000-0000-4000-a713|10\.20\.30\.40|2001:db8/);
        };
        const denials = (userId: number) => h.db.query(
            `SELECT result, status_code FROM admin_audit_events WHERE action = 'audit.exported' AND actor_user_id = $1`, [userId],
        );

        it('the files of the administrator carry no address and no declared field anywhere; those of root do', async () => {
            const secrets = ['10.20.30.40', '2001:db8::77', 'segundo renglón', '=cmd|calc', '"roleId"', 'Dirección IP', 'Campos declarados'];
            const csv = (await csvOf('admin')).res.text;
            const pdf = (await pdfOf('admin')).text;
            for (const secret of secrets) {
                expect(csv).not.toContain(secret);
                expect(pdf).not.toContain(squash(secret));
            }
            const rootPdf = (await pdfOf('root')).text;
            for (const secret of ['10.20.30.40', '2001:db8::77', 'segundorenglón', '=cmd|calc', 'DirecciónIP', 'Camposdeclarados']) {
                expect(rootPdf).toContain(squash(secret));
            }
        });

        it('root and the administrator exporting at the same time each get their own detail', async () => {
            const [rootPdf, adminPdf, rootCsv, adminCsv] = await Promise.all([pdfOf('root'), pdfOf('admin'), csvOf('root'), csvOf('admin')]);
            expect(rootPdf.text).toContain('10.20.30.40');
            expect(adminPdf.text).not.toContain('10.20.30.40');
            expect(rootCsv.columns).toEqual(ROOT_COLUMNS);
            expect(adminCsv.columns).toEqual(COLUMNS);
            expect(adminCsv.res.text).not.toContain('10.20.30.40');
        });

        it('an extra parameter cannot ask for the detail of another role', async () => {
            const res = await call('/audit/admin-events/export', tokens.admin, { ...window, format: 'csv', role: 'root' });
            expect(res.status).toBe(400);
            noRecords(res);
        });

        it.each([
            ['an invalid request', { format: 'xlsx', from: 'x' }],
            ['a result over the maximum', { format: 'pdf', from: '2019-03-09T00:00:00-04:00', to: '2019-03-10T00:00:00-04:00' }],
        ])('a role without permission gets 403 for %s, not a hint about it', async (_name, query) => {
            const res = await call('/audit/admin-events/export', tokens.supervisor, { ...window, ...query });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
            noRecords(res);
        });

        it('a token with a forged signature gets 401', async () => {
            const [header, payload, signature] = tokens.root.split('.');
            const forged = `${header}.${payload}.${signature!.startsWith('A') ? 'B' : 'A'}${signature!.slice(1)}`;
            const res = await call('/audit/admin-events/export', forged, { ...window, format: 'csv' });
            expect(res.status).toBe(401);
            noRecords(res);
        });

        it.each([
            ['demoted to coordinator', 'UPDATE users SET role_id = (SELECT role_id FROM roles WHERE name = \'coordinator\') WHERE user_id = $1', 403, 'INSUFFICIENT_PERMISSIONS'],
            ['deactivated', 'UPDATE users SET active = false WHERE user_id = $1', 401, 'INVALID_TOKEN'],
            ['forced to change the password', 'UPDATE users SET requires_pwd_change = true WHERE user_id = $1', 403, 'PASSWORD_CHANGE_REQUIRED'],
        ] as const)('an administrator %s after the token was issued gets no file', async (name, change, status, error) => {
            const user = await createUser('admin', `lost-${name.split(' ')[0]}`);
            expect((await exportFile(user.token, 'csv', {})).status).toBe(200);
            await h.db.query(change, [user.id]);
            for (const format of ['csv', 'pdf'] as const) {
                const res = await call('/audit/admin-events/export', user.token, { ...window, format });
                expect(res.status).toBe(status);
                expect(res.body.error).toBe(error);
                noRecords(res);
            }
            if (status === 403) {
                // PasswordChangeGuard records without waiting for the insert.
                await vi.waitFor(async () => expect((await denials(user.id)).filter((row: { result: string }) => row.result === 'denied')).toHaveLength(2));
            }
        });

        it('a PDF that fails to render sends no file, is audited as failed and leaves the CSV and the next PDF working', async () => {
            const user = await createUser('admin', 'render');
            const render = vi.spyOn(h.app.get(PdfPort, { strict: false }), 'generate').mockRejectedValueOnce(new PdfGenerationException('boom 10.20.30.40'));
            try {
                const res = await call('/audit/admin-events/export', user.token, { ...window, format: 'pdf' });
                expect(res.status).toBe(500);
                expect(res.headers['content-disposition']).toBeUndefined();
                expect(res.headers['content-type']).toMatch(/json/);
                expect(res.body.error).toBe('PDF_GENERATION_FAILED');
                expect(await denials(user.id)).toEqual([{ result: 'failed', status_code: 500 }]);
                expect((await exportFile(user.token, 'csv', {})).status).toBe(200);
                expect((await exportFile(user.token, 'pdf', {})).status).toBe(200);
            } finally {
                render.mockRestore();
            }
        });
    });
});
