// Guards the quality of the generated OpenAPI document (what Swagger UI shows), so a new endpoint or
// DTO field can't ship undocumented. It boots the real AppModule (needs the same DB as the other
// e2e specs) only because Nest builds the document from the running application.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module.js';

// Endpoints that are reachable without an access token (everything else must show the Bearer lock).
const PUBLIC = new Set([
    'get /api/health',
    'post /api/auth/login',
    'post /api/auth/refresh',
    'post /api/auth/forgot-password',
    'post /api/auth/reset-password',
]);

describe('Swagger document (e2e)', () => {
    let app: INestApplication;
    let doc: OpenAPIObject;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        app.setGlobalPrefix('api');
        await app.init();
        const config = new DocumentBuilder().addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token').build();
        doc = SwaggerModule.createDocument(app, config);
    });

    afterAll(async () => { await app.close(); });

    const operations = () => Object.entries(doc.paths).flatMap(([path, item]) =>
        Object.entries(item as Record<string, any>)
            .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
            .map(([method, op]) => ({ key: `${method} ${path}`, path, method, op })));

    it('every endpoint has a summary and a real description (what it does, its rules, who can call it)', () => {
        const bad = operations().filter(({ op }) => !op.summary || !op.description || op.description.length < 60).map((o) => o.key);
        expect(bad).toEqual([]);
    });

    it('every path and query parameter is described', () => {
        const bad = operations().flatMap(({ key, op }) => (op.parameters ?? []).filter((p: any) => !p.description).map((p: any) => `${key} → ${p.name}`));
        expect(bad).toEqual([]);
    });

    it('every endpoint with a :id documents the 400 for a non-numeric id', () => {
        const bad = operations().filter(({ path, op }) => path.includes('{id}') && !op.responses['400']?.content?.['application/json']?.examples?.INVALID_ID).map((o) => o.key);
        expect(bad).toEqual([]);
    });

    it('every endpoint that reads a body or query params documents the validation 400', () => {
        const bad = operations()
            .filter(({ op }) => op.requestBody || (op.parameters ?? []).some((p: any) => p.in === 'query'))
            .filter(({ op }) => !op.responses['400']?.content?.['application/json']?.examples?.VALIDATION_FAILED)
            .map((o) => o.key);
        expect(bad).toEqual([]);
    });

    it('every protected endpoint shows the Bearer lock, and public ones do not', () => {
        const bad = operations().filter(({ key, op }) => Boolean(op.security?.length) === PUBLIC.has(key)).map((o) => o.key);
        expect(bad).toEqual([]);
    });

    it('every protected endpoint documents the 401', () => {
        const bad = operations().filter(({ key, op }) => !PUBLIC.has(key) && !op.responses['401']).map((o) => o.key);
        expect(bad).toEqual([]);
    });

    it('the 400 validation example uses messages this endpoint can really return (not the generic placeholder)', () => {
        const bad = operations()
            .filter(({ op }) => op.responses['400']?.content?.['application/json']?.examples?.VALIDATION_FAILED)
            .filter(({ op }) => op.responses['400'].content['application/json'].examples.VALIDATION_FAILED.value.message.includes('A field is invalid.'))
            .map((o) => o.key);
        expect(bad).toEqual([]);
    });

    it('optional filters are not pre-filled: Swagger UI sends every `example` on "Try it out", so only page/limit carry one', () => {
        const bad = operations().flatMap(({ key, op }) => (op.parameters ?? [])
            .filter((p: any) => p.in === 'query' && !['page', 'limit'].includes(p.name) && (p.example !== undefined || p.schema?.example !== undefined))
            .map((p: any) => `${key} → ${p.name}`));
        expect(bad).toEqual([]);
    });

    it('page and limit are pre-filled with their defaults (1 and 10), so "Try it out" returns the first page', () => {
        const bad = operations().flatMap(({ key, op }) => (op.parameters ?? [])
            .filter((p: any) => p.in === 'query' && ((p.name === 'page' && p.schema?.example !== 1) || (p.name === 'limit' && p.schema?.example !== 10)))
            .map((p: any) => `${key} → ${p.name}`));
        expect(bad).toEqual([]);
    });

    it('every schema field is described and no nullable field is published as a bare "object"', () => {
        const bad: string[] = [];
        for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
            for (const [field, prop] of Object.entries((schema as any).properties ?? {}) as [string, any][]) {
                if (!prop.$ref && !prop.description) bad.push(`${name}.${field} has no description`);
                if (prop.type === 'object' && !prop.properties && !prop.$ref) bad.push(`${name}.${field} is typed as a bare object`);
            }
        }
        expect(bad).toEqual([]);
    });
});
