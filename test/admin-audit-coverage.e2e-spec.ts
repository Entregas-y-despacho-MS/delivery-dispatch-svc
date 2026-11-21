// RF-A35 / ST-68.2: coverage matrix action → handler. Walks the routes of the real application and checks both
// directions: every endpoint listed in ADMIN_AUDIT_CATALOG is decorated with exactly its action, and no handler is
// decorated with an action that does not list it. A catalogued handler that loses its decorator, or a decorator on a
// handler that the catalog does not list, fails here. It cannot tell that a NEW mutating handler is sensitive: that
// is decided by adding it to the catalog.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';
import { ADMIN_AUDIT_CATALOG, type AuditActionName } from '../src/modules/audit/admin-audit-events/domain/admin-audit-catalog.js';
import { AUDIT_ACTION_KEY, type AuditActionMetadata } from '../src/modules/audit/admin-audit-events/decorators/audit-action.decorator.js';

interface RouteHandler { route: string; handler: string; action: AuditActionName | null }

const join = (...parts: unknown[]): string =>
    '/' + parts.flatMap((part) => (Array.isArray(part) ? part : [part])).map((part) => String(part ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

describe('audit coverage matrix (ST-68.2)', () => {
    const h = new AuditE2eHarness('audit-coverage');
    let routes: RouteHandler[] = [];

    beforeAll(async () => {
        await h.start([]);
        routes = h.app.get(DiscoveryService).getControllers().flatMap(({ metatype }) => {
            if (!metatype) return [];
            const base = Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined;
            return Object.getOwnPropertyNames(metatype.prototype).flatMap((name) => {
                const handler = metatype.prototype[name] as unknown;
                if (typeof handler !== 'function') return [];
                const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
                if (verb === undefined) return [];
                const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
                const declared = Reflect.getMetadata(AUDIT_ACTION_KEY, handler) as AuditActionMetadata | undefined;
                return [{ route: `${RequestMethod[verb]} ${join(base, path)}`, handler: `${metatype.name}.${name}`, action: declared?.action ?? null }];
            });
        });
    }, 30_000);
    afterAll(async () => { await h.close(); });

    it('finds the routes of the application', () => {
        expect(routes.length).toBeGreaterThan(100);
    });

    const matrix = (Object.entries(ADMIN_AUDIT_CATALOG) as Array<[AuditActionName, { endpoints: readonly string[] }]>)
        .flatMap(([action, { endpoints }]) => endpoints.map((endpoint) => ({ action, endpoint })));

    it.each(matrix)('$endpoint is decorated with $action', ({ action, endpoint }) => {
        const found = routes.filter((route) => route.route === endpoint);
        expect(found, `no handler serves ${endpoint}`).toHaveLength(1);
        expect(found[0]!.action, `${found[0]!.handler} (${endpoint})`).toBe(action);
    });

    it('does not decorate any handler with an action that does not list it', () => {
        const listed = new Set(matrix.map(({ action, endpoint }) => `${action} ${endpoint}`));
        const unexpected = routes.filter((route) => route.action && !listed.has(`${route.action} ${route.route}`)).map((route) => `${route.handler} → ${route.action} (${route.route})`);
        expect(unexpected).toEqual([]);
    });

    it('lists every endpoint once, and every action has at least one', () => {
        const endpoints = matrix.map(({ endpoint }) => endpoint);
        expect(new Set(endpoints).size).toBe(endpoints.length);
        for (const [action, { endpoints: own }] of Object.entries(ADMIN_AUDIT_CATALOG)) expect(own.length, action).toBeGreaterThan(0);
    });
});
