// RF-A38 (ST-71.1): GET /audit/admin-events/export against the real AppModule and a real database.
// The events are inserted by the test inside windows of 2020, where nothing else writes, and deleted in afterAll together
// with the throwaway users. It deletes rows of an append-only table, so run it against a disposable database
// (postgres:18-alpine), never a shared one. The PDF is rendered by the real Puppeteer adapter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

type Who = 'admin' | 'coordinator' | 'supervisor' | 'driver' | 'root';
const WHO: Who[] = ['admin', 'coordinator', 'supervisor', 'driver', 'root'];

const binary = (res: NodeJS.ReadableStream & { setEncoding?: (e: string) => void }, done: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('admin audit export (RF-A38)', () => {
    let app: INestApplication;
    let db: DataSource;
    let api: string;
    const prefix = `e2e-auditx-${Date.now().toString(36)}`;
    const password = 'E2eAuditX1234!';
    const ids = {} as Record<Who, number>;
    const tokens = {} as Record<Who, string>;

    // Window [2020-05-10T04:00Z, 2020-05-11T04:00Z) written with the Bolivia offset, and a quiet one for the empty export.
    const window = { from: '2020-05-10T00:00:00-04:00', to: '2020-05-11T00:00:00-04:00' };
    const emptyWindow = { from: '2020-06-10T00:00:00-04:00', to: '2020-06-11T00:00:00-04:00' };
    // The big window holds the rows that exceed the PDF maximum (2000).
    const bigWindow = { from: '2020-07-10T00:00:00-04:00', to: '2020-07-11T00:00:00-04:00' };
    const uuid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

    const get = (path: string, who: Who | null, query: Record<string, string | number>) => {
        const call = request(app.getHttpServer()).get(`/${api}/audit/admin-events${path}`).query(query);
        return who ? call.set('Authorization', `Bearer ${tokens[who]}`) : call;
    };
    const search = async (who: Who, query: Record<string, string | number> = {}): Promise<string[]> => {
        const out: string[] = [];
        for (let page = 1; ; page++) {
            const res = await get('', who, { ...window, ...query, page, limit: 3 });
            expect(res.status).toBe(200);
            out.push(...res.body.data.map((event: { eventId: string }) => event.eventId));
            if (page >= res.body.meta.pages) return out;
        }
    };
    const exportCsv = (who: Who | null, query: Record<string, string | number> = {}) => get('/export', who, { ...window, format: 'csv', ...query });
    const exportPdf = (who: Who | null, query: Record<string, string | number> = {}) =>
        get('/export', who, { ...window, format: 'pdf', ...query }).buffer(true).parse(binary as never);

    /** Header block, column names and the cells of the first two columns (date and event id) of each row. */
    const readCsv = (text: string) => {
        const lines = text.replace(/^﻿/, '').split('\r\n');
        const headerAt = lines.findIndex((line) => line.startsWith('Fecha y hora,'));
        return {
            context: lines.slice(0, headerAt - 1),
            columns: lines[headerAt]!.split(','),
            rows: lines.slice(headerAt + 1).filter(Boolean),
            ids: lines.slice(headerAt + 1).filter(Boolean).map((line) => line.split(',')[1]!),
        };
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        api = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(api);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const roles: Record<string, number> = {};
        for (const row of await db.query('SELECT role_id, name FROM roles')) roles[row.name] = row.role_id;
        const hash = await hashPassword(password);
        for (const who of WHO) {
            const [{ user_id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roles[who], `E2E audit export ${who}`, `${prefix}-${who}`, hash],
            );
            ids[who] = user_id;
            const res = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username: `${prefix}-${who}`, password });
            tokens[who] = res.body.accessToken as string;
        }

        // [n, occurred_at, actor, role, action, entityType, entityId, result, status, ip, metadata]
        const events: Array<[number, string, number | null, string | null, string, string | null, string | null, string, number, string | null, object]> = [
            [1, '2020-05-10T10:00:00Z', ids.admin, 'admin', 'user.created', 'user', '501', 'success', 201, '10.1.2.3', { roleId: 3 }],
            [2, '2020-05-10T10:00:00Z', ids.admin, 'admin', 'user.updated', 'user', '501', 'success', 200, '10.1.2.3', {}],
            [3, '2020-05-10T10:00:00Z', ids.coordinator, 'coordinator', 'setting.updated', 'setting', 'k', 'denied', 403, '10.9.9.9', {}],
            [4, '2020-05-10T11:00:00Z', ids.coordinator, 'coordinator', 'catalog.changed', 'catalog', null, 'failed', 500, null, {}],
            [5, '2020-05-10T12:00:00Z', null, null, 'user.deleted', 'user', '502', 'denied', 401, null, {}],
            [6, '2020-05-10T13:00:00Z', ids.admin, 'admin', 'vehicle.changed', 'vehicle', '7', 'success', 200, null, {}],
            [7, '2020-05-10T04:00:00Z', ids.admin, 'admin', 'user.created', 'user', '503', 'success', 201, null, {}],
            // Exactly on 'to': outside the window.
            [8, '2020-05-11T04:00:00Z', ids.admin, 'admin', 'user.created', 'user', '504', 'success', 201, null, {}],
            // Values that a spreadsheet or a browser would run.
            [9, '2020-05-10T14:00:00Z', ids.admin, 'admin', 'user.created', 'user', '=1+1', 'success', 201, null, {}],
            [10, '2020-05-10T15:00:00Z', ids.admin, 'admin', 'user.created', 'user', '<script>alert(1)</script>', 'success', 201, null, {}],
        ];
        for (const [n, at, actor, role, action, type, entityId, result, status, ip, metadata] of events) {
            await db.query(
                `INSERT INTO admin_audit_events (admin_audit_event_id, actor_user_id, actor_role, action, entity_type, entity_id, result, status_code, correlation_id, ip_address, metadata, occurred_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [uuid(n), actor, role, action, type, entityId, result, status, `${prefix}-ev${n}`, ip, JSON.stringify(metadata), at],
            );
        }
        // 2001 events: one over the PDF maximum, well under the CSV one.
        await db.query(
            `INSERT INTO admin_audit_events (admin_audit_event_id, actor_user_id, actor_role, action, entity_type, entity_id, result, status_code, correlation_id, occurred_at)
             SELECT gen_random_uuid(), $1, 'admin', 'user.updated', 'user', g::text, 'success', 200, $2 || '-big' || g, '2020-07-10T10:00:00Z'::timestamptz + (g || ' seconds')::interval
             FROM generate_series(1, 2001) g`,
            [ids.admin, prefix],
        );
    }, 120_000);

    afterAll(async () => {
        if (db?.isInitialized) {
            await db.query('DELETE FROM admin_audit_events WHERE correlation_id LIKE $1', [`${prefix}-%`]);
            await db.query('DELETE FROM admin_audit_events WHERE actor_user_id = ANY($1::int[]) OR admin_audit_event_id::text LIKE $2', [Object.values(ids), '00000000-0000-4000-9000-%']);
            await db.query('DELETE FROM users WHERE username LIKE $1', [`${prefix}-%`]);
        }
        await app?.close();
    });

    describe('fidelity with the search', () => {
        it.each(['desc', 'asc'] as const)('the CSV holds the same ids in the same order as the search (%s)', async (order) => {
            const expected = await search('admin', { order });
            expect(expected).toHaveLength(9); // events 1-7, 9 and 10: the one on 'to' is out
            const res = await exportCsv('admin', { order });
            expect(res.status).toBe(200);
            expect(readCsv(res.text).ids).toEqual(expected);
        });

        it('the PDF holds the same ids in the same order as the search', async () => {
            const expected = await search('admin', { order: 'asc' });
            const res = await exportPdf('admin', { order: 'asc' });
            expect(res.status).toBe(200);
            expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
            expect(res.body.length).toBeGreaterThan(1000);
            // The same query feeds both formats, so the CSV of the same request is the oracle of the PDF's rows.
            expect(readCsv((await exportCsv('admin', { order: 'asc' })).text).ids).toEqual(expected);
        });

        it('applies the filters of the search to the file', async () => {
            const filters = { action: 'user.created', result: 'success' };
            const expected = await search('admin', filters);
            expect(expected.length).toBeGreaterThan(0);
            expect(expected.length).toBeLessThan(9);
            const csv = readCsv((await exportCsv('admin', filters)).text);
            expect(csv.ids).toEqual(expected);
            expect(csv.context).toEqual(expect.arrayContaining(['Filtro: Acción,user.created', 'Filtro: Resultado,success']));
        });

        it('ignores page and limit: the file is never a page', async () => {
            const all = readCsv((await exportCsv('admin')).text).ids;
            const paged = readCsv((await exportCsv('admin', { page: 2, limit: 3 })).text).ids;
            expect(paged).toEqual(all);
            expect(all).toHaveLength(9);
        });

        it('states the period with its borders, the zone, the generation time and the count', async () => {
            const { context } = readCsv((await exportCsv('admin')).text);
            expect(context).toEqual(expect.arrayContaining([
                'Período desde (incluido),2020-05-10 00:00:00', 'Período hasta (excluido),2020-05-11 00:00:00', 'Zona horaria,America/La_Paz', 'Total de filas,9',
            ]));
            expect(context.some((line) => /^Generado el,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(line))).toBe(true);
        });

        it('an empty window is a valid file with a zero count', async () => {
            const res = await get('/export', 'admin', { ...emptyWindow, format: 'csv' });
            expect(res.status).toBe(200);
            const csv = readCsv(res.text);
            expect(csv.ids).toEqual([]);
            expect(csv.context).toContain('Total de filas,0');
        });

        it('sends the file as an attachment named after the Bolivia day, never cached', async () => {
            const csv = await exportCsv('admin');
            expect(csv.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
            expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="auditoria-admin-\d{4}-\d{2}-\d{2}\.csv"$/);
            expect(csv.headers['cache-control']).toBe('no-store');
            const pdf = await exportPdf('admin');
            expect(pdf.headers['content-type']).toBe('application/pdf');
            expect(pdf.headers['content-disposition']).toMatch(/filename="auditoria-admin-\d{4}-\d{2}-\d{2}\.pdf"$/);
        });
    });

    describe('what the role may see', () => {
        it('gives the administrator no address and no declared fields', async () => {
            const csv = readCsv((await exportCsv('admin')).text);
            expect(csv.columns).not.toContain('Dirección IP');
            expect(csv.columns).not.toContain('Campos declarados');
            expect((await exportCsv('admin')).text).not.toContain('10.1.2.3');
        });

        it('gives root the address and the declared fields, with the same rows', async () => {
            const res = await exportCsv('root');
            expect(res.status).toBe(200);
            const csv = readCsv(res.text);
            expect(csv.columns.slice(-2)).toEqual(['Dirección IP', 'Campos declarados']);
            expect(res.text).toContain('10.1.2.3');
            expect(csv.ids).toEqual(readCsv((await exportCsv('admin')).text).ids);
        });
    });

    describe('dangerous input', () => {
        it('neutralizes a value that starts like a formula, in the rows and in the filter echo', async () => {
            const res = await exportCsv('admin');
            expect(res.text).toContain(`,user,'=1+1,`);
            expect(res.text).not.toMatch(/,user,=1\+1,/);
            const filtered = await exportCsv('admin', { entityType: 'user', entityId: '=1+1' });
            expect(filtered.status).toBe(200);
            expect(filtered.text).toContain("Filtro: Id de la entidad,'=1+1");
            expect(readCsv(filtered.text).ids).toHaveLength(1);
        });

        it('renders markup in a value as text in the PDF', async () => {
            const res = await exportPdf('admin', { entityType: 'user', entityId: '<script>alert(1)</script>' });
            expect(res.status).toBe(200);
            expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
        });
    });

    describe('limits and validation: nothing is sent', () => {
        const noFile = (res: { status: number; headers: Record<string, string>; body: unknown }) => {
            expect(res.status).toBe(400);
            expect(res.headers['content-type']).toMatch(/json/);
            expect(res.headers['content-disposition']).toBeUndefined();
        };

        it('rejects a PDF over 2000 rows with the way to continue, and still gives the CSV of the same window', async () => {
            const pdf = await get('/export', 'admin', { ...bigWindow, format: 'pdf' });
            noFile(pdf);
            expect(pdf.body).toMatchObject({ error: 'AUDIT_EXPORT_LIMIT_EXCEEDED' });
            expect(pdf.body.message).toMatch(/2000.*Narrow the 'from'\/'to' window or add filters/);
            const csv = await get('/export', 'admin', { ...bigWindow, format: 'csv' });
            expect(csv.status).toBe(200);
            expect(readCsv(csv.text).ids).toHaveLength(2001);
            const narrowed = await get('/export', 'admin', { ...bigWindow, format: 'pdf', entityId: '5', entityType: 'user' });
            expect(narrowed.status).toBe(200);
        });

        it.each([
            ['no format', { ...window }],
            ['an unknown format', { ...window, format: 'xlsx' }],
            ['a window wider than 31 days', { from: '2020-05-01T00:00:00-04:00', to: '2020-06-05T00:00:00-04:00', format: 'csv' }],
            ['a reversed window', { from: window.to, to: window.from, format: 'csv' }],
            ['a window without a zone', { from: '2020-05-10T00:00:00', to: '2020-05-11T00:00:00', format: 'csv' }],
            ['an entity id without type', { ...window, format: 'csv', entityId: '9' }],
            ['an unknown filter', { ...window, format: 'csv', bogus: 'x' }],
        ])('rejects %s with 400 and no file', async (_name, query) => {
            noFile(await get('/export', 'admin', query as Record<string, string>));
        });
    });

    describe('authorization', () => {
        it('answers 401 without a token and sends no file', async () => {
            const res = await exportCsv(null);
            expect(res.status).toBe(401);
            expect(res.headers['content-disposition']).toBeUndefined();
        });

        it.each(['coordinator', 'supervisor', 'driver'] as const)('answers 403 to the %s and sends no file', async (who) => {
            for (const res of [await exportCsv(who), await exportPdf(who)]) {
                expect(res.status).toBe(403);
                expect(res.headers['content-disposition']).toBeUndefined();
                expect(res.headers['content-type']).toMatch(/json/);
            }
        });

        it('lets the administrator and root in', async () => {
            expect((await exportCsv('admin')).status).toBe(200);
            expect((await exportCsv('root')).status).toBe(200);
        });
    });

    describe('the export is itself audited', () => {
        const exported = (who: Who) => db.query(
            `SELECT result, status_code, entity_id, metadata FROM admin_audit_events WHERE action = 'audit.exported' AND actor_user_id = $1 ORDER BY occurred_at DESC, admin_audit_event_id DESC`,
            [ids[who]],
        );

        it('records who exported, in which format and with which filters', async () => {
            const before = (await exported('admin')).length;
            await exportCsv('admin', { action: 'user.created', order: 'asc' });
            const rows = await exported('admin');
            expect(rows).toHaveLength(before + 1);
            expect(rows[0]).toMatchObject({ result: 'success', status_code: 200, entity_id: null });
            expect(rows[0].metadata).toMatchObject({ format: 'csv', from: window.from, to: window.to, action: 'user.created', order: 'asc' });
        });

        it('records a rejected export as failed and a denied one as denied', async () => {
            await get('/export', 'admin', { ...bigWindow, format: 'pdf' });
            expect((await exported('admin'))[0]).toMatchObject({ result: 'failed', status_code: 400 });
            await exportCsv('coordinator');
            expect((await exported('coordinator'))[0]).toMatchObject({ result: 'denied', status_code: 403 });
        });

        it('never records the rows or the address in the audit of the export', async () => {
            await exportCsv('root');
            const [row] = await exported('root');
            expect(JSON.stringify(row.metadata)).not.toMatch(/10\.1\.2\.3|=1\+1/);
        });
    });
});
