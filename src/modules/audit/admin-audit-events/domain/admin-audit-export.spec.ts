import { describe, expect, it } from 'vitest';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { buildAuditCsv, buildAuditPdfHtml, describeFilters, escapeHtml, exportColumns, type AuditExportContext } from './admin-audit-export.js';
import type { AuditEventView } from './admin-audit-query.js';

const event = (over: Partial<AuditEventView> = {}): AuditEventView => ({
    eventId: '11111111-1111-1111-1111-111111111111', occurredAt: new Date('2026-11-20T14:30:00Z'), actorId: 4, actorRole: 'admin',
    action: 'user.created', entityType: 'user', entityId: '9', result: 'success', statusCode: 201, correlationId: 'req-123456', ...over,
});

const context = (over: Partial<AuditExportContext> = {}): AuditExportContext => ({
    from: new Date('2026-11-20T04:00:00Z'), to: new Date('2026-11-21T04:00:00Z'), generatedAt: new Date('2026-11-24T16:05:09Z'),
    filters: { order: 'desc' }, role: RoleEnum.ADMIN, ...over,
});

const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n');

describe('describeFilters', () => {
    it('lists only the filters that were applied, then the order', () => {
        expect(describeFilters({ order: 'asc' })).toEqual([['Orden', 'Más antiguos primero']]);
        expect(describeFilters({ actorId: 4, action: 'user.created', result: 'failed', order: 'desc' })).toEqual([
            ['Id del actor', '4'], ['Acción', 'user.created'], ['Resultado', 'failed'], ['Orden', 'Más recientes primero'],
        ]);
    });
});

describe('exportColumns', () => {
    it('gives the administrator no address and no declared fields, and root both', () => {
        expect(exportColumns(RoleEnum.ADMIN).map((c) => c.header)).not.toContain('Dirección IP');
        expect(exportColumns(RoleEnum.ADMIN).map((c) => c.header)).not.toContain('Campos declarados');
        expect(exportColumns(RoleEnum.ROOT).map((c) => c.header)).toEqual(expect.arrayContaining(['Dirección IP', 'Campos declarados']));
    });
});

describe('buildAuditCsv', () => {
    it('starts with the byte-order mark and ends every line with CRLF', () => {
        const csv = buildAuditCsv(context(), [event()]);
        expect(csv.startsWith('﻿')).toBe(true);
        expect(csv.endsWith('\r\n')).toBe(true);
        expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    });

    it('states the period (both borders), the filters, the generation time and the row count before the rows', () => {
        const rows = lines(buildAuditCsv(context({ filters: { action: 'user.created', order: 'desc' } }), [event(), event({ eventId: 'e2' })]));
        expect(rows.slice(0, 11)).toEqual([
            'Auditoría administrativa',
            'Período desde (incluido),2026-11-20 00:00:00',
            'Período hasta (excluido),2026-11-21 00:00:00',
            'Zona horaria,America/La_Paz',
            'Filtro: Acción,user.created',
            'Filtro: Orden,Más recientes primero',
            'Generado el,2026-11-24 12:05:09',
            'Total de filas,2',
            '',
            'Fecha y hora,Id del evento,Id del actor,Rol del actor,Acción,Tipo de entidad,Id de la entidad,Resultado,Código HTTP,Correlación',
            '2026-11-20 10:30:00,11111111-1111-1111-1111-111111111111,4,admin,user.created,user,9,Exitoso,201,req-123456',
        ]);
    });

    it('keeps the order of the events it is given', () => {
        const rows = lines(buildAuditCsv(context(), [event({ eventId: 'b' }), event({ eventId: 'a' }), event({ eventId: 'c' })]));
        expect(rows.slice(9, 12).map((row) => row.split(',')[1])).toEqual(['b', 'a', 'c']);
    });

    it.each(['=HYPERLINK("x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])('neutralizes a value that starts like a formula (%j)', (value) => {
        const csv = buildAuditCsv(context(), [event({ entityId: value })]);
        const cell = lines(csv)[9]!.split(',')[6]!;
        expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    });

    it('neutralizes a formula typed into a filter value, which comes from the request', () => {
        const rows = lines(buildAuditCsv(context({ filters: { entityType: 'user', entityId: '=1+1', order: 'desc' } }), []));
        expect(rows).toContain("Filtro: Id de la entidad,'=1+1");
    });

    it('quotes values with commas, quotes and line breaks', () => {
        const csv = buildAuditCsv(context({ role: RoleEnum.ROOT }), [event({ ip: '10.0.0.7', metadata: { note: 'a,b "c"' } })]);
        expect(csv).toContain('"{""note"":""a,b \\""c\\""""}"');
    });

    it('adds the address and the declared fields only for root', () => {
        const withDetail = event({ ip: '10.0.0.7', metadata: { zoneCode: 'Z1' } });
        const admin = lines(buildAuditCsv(context(), [withDetail]));
        expect(admin[8]).not.toContain('Dirección IP');
        expect(admin.join('')).not.toContain('10.0.0.7');
        const root = lines(buildAuditCsv(context({ role: RoleEnum.ROOT }), [withDetail]));
        expect(root[8]).toMatch(/,Dirección IP,Campos declarados$/);
        expect(root[9]).toMatch(/,10\.0\.0\.7,"\{""zoneCode"":""Z1""\}"$/);
    });

    it('exports an empty result as headers only, with a zero count', () => {
        const rows = lines(buildAuditCsv(context(), []));
        expect(rows).toContain('Total de filas,0');
        expect(rows.filter(Boolean)).toHaveLength(8);
    });
});

describe('escapeHtml', () => {
    it('escapes markup characters and tolerates null', () => {
        expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(0)).toBe('0');
    });
});

describe('buildAuditPdfHtml', () => {
    it('carries the period, the filters, the generation time and a column per field', () => {
        const html = buildAuditPdfHtml(context({ filters: { result: 'failed', order: 'asc' } }), [event()]);
        for (const text of ['2026-11-20 00:00:00', '2026-11-21 00:00:00', 'America/La_Paz', 'Filtro: Resultado', 'failed', 'Más antiguos primero', '2026-11-24 12:05:09', 'Total de filas']) {
            expect(html).toContain(text);
        }
        for (const column of exportColumns(RoleEnum.ADMIN)) expect(html).toContain(`<th>${column.header}</th>`);
        expect(html).toContain('2026-11-20 10:30:00');
        expect(html).toContain('11111111-1111-1111-1111-111111111111');
    });

    it('shows the catalog description next to the action code', () => {
        expect(buildAuditPdfHtml(context(), [event()])).toContain('user.created<br><span class="muted">Create an internal user account</span>');
        expect(buildAuditPdfHtml(context(), [event({ action: 'old.action' })])).toContain('<td>old.action</td>');
    });

    it('escapes every value it prints, rows and filters alike', () => {
        const hostile = '<script>alert(1)</script>';
        const html = buildAuditPdfHtml(context({ filters: { entityType: 'user', entityId: hostile, order: 'desc' } }), [event({ entityId: hostile, actorRole: '<b>x</b>' })]);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>x</b>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('forces a light page, so the text stays readable whatever color scheme the rendering browser prefers', () => {
        const html = buildAuditPdfHtml(context(), []);
        expect(html).toContain('color-scheme: only light');
        expect(html).toMatch(/body \{[^}]*background: #fff/);
    });

    it('blocks scripts and network requests with a content security policy', () => {
        expect(buildAuditPdfHtml(context(), [])).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    });

    it('keeps the order of the events and the same columns as the CSV for each role', () => {
        const html = buildAuditPdfHtml(context(), [event({ eventId: 'b-id' }), event({ eventId: 'a-id' })]);
        expect(html.indexOf('b-id')).toBeLessThan(html.indexOf('a-id'));
        const adminHtml = buildAuditPdfHtml(context(), [event({ ip: '10.0.0.7', metadata: {} })]);
        expect(adminHtml).not.toContain('Dirección IP');
        expect(buildAuditPdfHtml(context({ role: RoleEnum.ROOT }), [event({ ip: '10.0.0.7', metadata: {} })])).toContain('<th>Dirección IP</th>');
    });

    it('says so, instead of printing an empty table, when nothing matches', () => {
        const html = buildAuditPdfHtml(context(), []);
        expect(html).toContain('No hay eventos de auditoría');
        expect(html).not.toContain('<table>');
    });
});
