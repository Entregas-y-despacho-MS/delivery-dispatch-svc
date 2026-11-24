import { RoleEnum } from '../../../../shared/enums/index.js';
import { OPERATING_TIME_ZONE } from '../../../dispatch/dispatches/utils/operating-date.util.js';
import { CSV_BOM, csvLine, formatLocalDateTime } from '../../../dispatch/dispatch-history/utils/csv.js';
import { ADMIN_AUDIT_CATALOG } from './admin-audit-catalog.js';
import type { AuditEventView, AuditOrder } from './admin-audit-query.js';

/** The filters of a search, as they are echoed in the header of the exported file. */
export interface AuditExportFilters {
    actorId?: number;
    actorRole?: string;
    action?: string;
    entityType?: string;
    entityId?: string;
    result?: string;
    correlationId?: string;
    order: AuditOrder;
}

/** Everything the file says about itself besides the rows. */
export interface AuditExportContext {
    /** Window `[from, to)` of the search. */
    from: Date;
    to: Date;
    generatedAt: Date;
    filters: AuditExportFilters;
    role: RoleEnum;
}

const ORDER_LABEL: Record<AuditOrder, string> = { desc: 'Más recientes primero', asc: 'Más antiguos primero' };

const RESULT_LABEL: Record<string, string> = { success: 'Exitoso', denied: 'Denegado', failed: 'Fallido' };

/** `[label, value]` of every filter that was applied, in a fixed order; the order of the rows is always listed. */
export function describeFilters(filters: AuditExportFilters): [string, string][] {
    const lines: [string, string][] = [];
    if (filters.actorId !== undefined) lines.push(['Id del actor', String(filters.actorId)]);
    if (filters.actorRole !== undefined) lines.push(['Rol del actor', filters.actorRole]);
    if (filters.action !== undefined) lines.push(['Acción', filters.action]);
    if (filters.entityType !== undefined) lines.push(['Tipo de entidad', filters.entityType]);
    if (filters.entityId !== undefined) lines.push(['Id de la entidad', filters.entityId]);
    if (filters.result !== undefined) lines.push(['Resultado', filters.result]);
    if (filters.correlationId !== undefined) lines.push(['Correlación', filters.correlationId]);
    lines.push(['Orden', ORDER_LABEL[filters.order]]);
    return lines;
}

/** Only the break-glass account (ROOT) may read the client address and the declared fields of an event. */
export const includesSensitiveDetail = (role: RoleEnum): boolean => role === RoleEnum.ROOT;

interface Column {
    header: string;
    value: (event: AuditEventView) => string | number | null;
}

const COMMON_COLUMNS: Column[] = [
    { header: 'Fecha y hora', value: (event) => formatLocalDateTime(event.occurredAt) },
    { header: 'Id del evento', value: (event) => event.eventId },
    { header: 'Id del actor', value: (event) => event.actorId },
    { header: 'Rol del actor', value: (event) => event.actorRole },
    { header: 'Acción', value: (event) => event.action },
    { header: 'Tipo de entidad', value: (event) => event.entityType },
    { header: 'Id de la entidad', value: (event) => event.entityId },
    { header: 'Resultado', value: (event) => RESULT_LABEL[event.result] ?? event.result },
    { header: 'Código HTTP', value: (event) => event.statusCode },
    { header: 'Correlación', value: (event) => event.correlationId },
];

const SENSITIVE_COLUMNS: Column[] = [
    { header: 'Dirección IP', value: (event) => event.ip ?? null },
    { header: 'Campos declarados', value: (event) => (event.metadata ? JSON.stringify(event.metadata) : null) },
];

/** The columns a role may see: the same for the CSV and the PDF, so a file never carries more than the screen. */
export function exportColumns(role: RoleEnum): Column[] {
    return includesSensitiveDetail(role) ? [...COMMON_COLUMNS, ...SENSITIVE_COLUMNS] : COMMON_COLUMNS;
}

/** The text of the period, with its borders spelled out (`from` is included, `to` is not) and the time zone. */
function periodLines(context: AuditExportContext): [string, string][] {
    return [
        ['Período desde (incluido)', formatLocalDateTime(context.from)],
        ['Período hasta (excluido)', formatLocalDateTime(context.to)],
        ['Zona horaria', OPERATING_TIME_ZONE],
    ];
}

/**
 * The CSV of an export: UTF-8 with a byte-order mark, CRLF, a header block (period, filters, generation time and
 * number of rows), a blank line, the column headers and one line per event. Every cell goes through `csvLine`, so a
 * value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is neutralized, and quotes and commas are
 * escaped; that includes the filter values, which come from the request.
 */
export function buildAuditCsv(context: AuditExportContext, events: readonly AuditEventView[]): string {
    const columns = exportColumns(context.role);
    const lines: string[] = [
        csvLine(['Auditoría administrativa']),
        ...periodLines(context).map(([label, value]) => csvLine([label, value])),
        ...describeFilters(context.filters).map(([label, value]) => csvLine([`Filtro: ${label}`, value])),
        csvLine(['Generado el', formatLocalDateTime(context.generatedAt)]),
        csvLine(['Total de filas', events.length]),
        csvLine([]),
        csvLine(columns.map((column) => column.header)),
        ...events.map((event) => csvLine(columns.map((column) => column.value(event)))),
    ];
    return CSV_BOM + lines.join('');
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every value that reaches the HTML goes through here: a name or a filter typed by a person is text, never markup. */
export function escapeHtml(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

const PDF_STYLES = `
    @page { margin: 12mm 8mm; }
    html { color-scheme: only light; background: #fff; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 8px; color: #111; background: #fff; }
    h1 { font-size: 15px; margin: 0 0 6px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 1px 10px; margin: 0 0 10px; font-size: 9px; }
    dt { font-weight: bold; }
    dd { margin: 0; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th, td { border: 1px solid #bbb; padding: 2px 3px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #e8e8e8; }
    .muted { color: #555; }
    .empty { margin-top: 12px; font-size: 10px; }
`;

function pdfCell(column: Column, event: AuditEventView): string {
    const text = escapeHtml(column.value(event));
    if (column.header !== 'Acción') return text;
    const description = ADMIN_AUDIT_CATALOG[event.action as keyof typeof ADMIN_AUDIT_CATALOG]?.description;
    return description ? `${text}<br><span class="muted">${escapeHtml(description)}</span>` : text;
}

/**
 * The HTML the PDF is rendered from: title, period, filters, generation time and number of rows, then a table with the
 * same columns, in the same order, as the CSV (the header row repeats on every page). Content-Security-Policy blocks
 * scripts and any network request, as a second barrier behind the escaping of every value.
 */
export function buildAuditPdfHtml(context: AuditExportContext, events: readonly AuditEventView[]): string {
    const columns = exportColumns(context.role);
    const summary: [string, string][] = [
        ...periodLines(context),
        ...describeFilters(context.filters).map(([label, value]): [string, string] => [`Filtro: ${label}`, value]),
        ['Generado el', formatLocalDateTime(context.generatedAt)],
        ['Total de filas', String(events.length)],
    ];
    const summaryHtml = summary.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
    const head = columns.map((column) => `<th>${escapeHtml(column.header)}</th>`).join('');
    const body = events
        .map((event) => `<tr>${columns.map((column) => `<td>${pdfCell(column, event)}</td>`).join('')}</tr>`)
        .join('');
    const table = events.length === 0
        ? '<p class="empty">No hay eventos de auditoría para los filtros y el período indicados.</p>'
        : `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">`
        + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
        + `<title>Auditoría administrativa</title><style>${PDF_STYLES}</style></head>`
        + `<body><h1>Auditoría administrativa</h1><dl>${summaryHtml}</dl>${table}</body></html>`;
}
