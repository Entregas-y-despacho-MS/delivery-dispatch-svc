import { LogLevel } from '@nestjs/common';
import { AppConfig } from '../services/app.config.js';
import { EnvironmentEnum } from '../../shared/enums/index.js';

const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    red:    '\x1b[31m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    cyan:   '\x1b[36m',
    white:  '\x1b[37m',
};

const ENV_COLOR: Record<string, string> = {
    [EnvironmentEnum.PRODUCTION]:  C.red,
    [EnvironmentEnum.DEVELOPMENT]: C.green,
    [EnvironmentEnum.TEST]:        C.yellow,
    [EnvironmentEnum.DEBUG]:       C.cyan,
};

const OK   = `${C.green}✔${C.reset}`;
const FAIL = `${C.red}✘${C.reset}`;
const WARN = `${C.yellow}⚠${C.reset}`;

function vis(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function rpad(s: string, w: number): string {
    return s + ' '.repeat(Math.max(0, w - vis(s)));
}

function center(s: string, w: number): string {
    const l = Math.floor((w - vis(s)) / 2);
    const r = w - vis(s) - l;
    return ' '.repeat(l) + s + ' '.repeat(r);
}

export interface ServerBannerOptions {
    swagger:    boolean;
    docsPath:   string;
    cors:       string;
    logLevels:  LogLevel[];
    /** Defined only when the auth plugin is active. */
    jwtActive?: boolean;
    /** Defined only when the database plugin is active. */
    dbLogs?:    boolean;
    /** Defined only when the database plugin is active. */
    database?:  string;
    /** Defined only when the observe plugin is active. */
    observeConfigured?: boolean;
}

/**
 * Prints a formatted startup banner with environment, URL, and feature status.
 * Plugin-specific rows (JWT, DB) are rendered only when those options are provided.
 */
export function logServerStatus(cfg: AppConfig, appName: string, opts: ServerBannerOptions): void {
    const color   = ENV_COLOR[cfg.nodeEnv] ?? C.green;
    const baseUrl = `http://localhost:${cfg.port}`;
    const apiUrl  = `${baseUrl}/${cfg.apiPrefix}`;

    const infoRows: [string, string][] = [
        ['Environment', `${color}${C.bold}${cfg.nodeEnv.toUpperCase()}${C.reset}`],
        ['Port',        `${color}${cfg.port}${C.reset}`],
        ['URL',         `${color}${apiUrl}${C.reset}`],
    ];

    const corsDisplay = opts.cors === '*'
        ? `${WARN} ${C.yellow}All origins${C.reset} ${C.dim}(*)${C.reset}`
        : `${OK} ${opts.cors}`;

    const featureRows: [string, string][] = [
        ['Swagger', opts.swagger
            ? `${OK} ${C.cyan}${baseUrl}/${opts.docsPath}${C.reset}`
            : `${FAIL} ${C.dim}Disabled${C.reset}`],
        ...(opts.jwtActive !== undefined ? [['JWT Auth', opts.jwtActive
            ? `${OK} ${C.green}Active${C.reset}`
            : `${WARN} ${C.yellow}Bypassed${C.reset} ${C.dim}(ACTIVE_JWT=false)${C.reset}`] as [string, string]] : []),
        ...(opts.dbLogs !== undefined ? [['DB Logs', opts.dbLogs
            ? `${OK} ${C.green}Enabled${C.reset}`
            : `${FAIL} ${C.dim}Disabled${C.reset}`] as [string, string]] : []),
        ...(opts.observeConfigured !== undefined ? [['Observe', opts.observeConfigured
            ? `${OK} ${C.green}Configured${C.reset}`
            : `${WARN} ${C.yellow}No credentials${C.reset} ${C.dim}(observe.nestjs.com)${C.reset}`] as [string, string]] : []),
        ['CORS', corsDisplay],
    ];

    const connRows: [string, string][] = [
        ...(opts.database ? [['Database', `${C.dim}${opts.database}${C.reset}`] as [string, string]] : []),
        ['Log Level', `${C.dim}${opts.logLevels.join(', ')}${C.reset}`],
    ];

    const allRows  = [...infoRows, ...featureRows, ...connRows];
    const LABEL_W  = Math.max(...allRows.map(([l]) => l.length));
    const VALUE_W  = Math.max(
        vis(`${C.bold}${C.white}${appName}${C.reset}`) + 2,
        ...allRows.map(([, v]) => vis(v)),
    );

    const L_DASHES = '─'.repeat(LABEL_W + 4);
    const R_DASHES = '─'.repeat(VALUE_W + 4);
    const FULL_W   = LABEL_W + VALUE_W + 9;
    const titleStr = `${C.bold}${C.white}${appName}${C.reset}`;

    const line = (l: string, m: string, r: string) =>
        `  ${C.dim}${l}${L_DASHES}${m}${R_DASHES}${r}${C.reset}`;

    const row = (label: string, value: string) =>
        `  ${C.dim}│${C.reset}  ${C.dim}${label.padEnd(LABEL_W)}${C.reset}  ${C.dim}│${C.reset}  ${rpad(value, VALUE_W)}  ${C.dim}│${C.reset}`;

    console.log();
    console.log(`  ${C.dim}┌${'─'.repeat(FULL_W)}┐${C.reset}`);
    console.log(`  ${C.dim}│${C.reset}${center(titleStr, FULL_W)}${C.dim}│${C.reset}`);
    console.log(line('├', '┬', '┤'));
    for (const [l, v] of infoRows)    console.log(row(l, v));
    console.log(line('├', '┼', '┤'));
    for (const [l, v] of featureRows) console.log(row(l, v));
    console.log(line('├', '┼', '┤'));
    for (const [l, v] of connRows)    console.log(row(l, v));
    console.log(`  ${C.dim}└${L_DASHES}┴${R_DASHES}┘${C.reset}`);
    console.log();
}
