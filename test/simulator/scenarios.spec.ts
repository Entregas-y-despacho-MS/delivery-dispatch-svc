import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { buildScenario, FIXTURES_DIR, loadScenario, loadScenarios } from './scenarios.js';

/**
 * Fixtures of the ERP simulator (ST-73.2): every file is a valid scenario, its messages meet the
 * contracts of ST-76.1 (except the ones that are invalid on purpose) and the builder keeps the
 * properties the scenarios rely on (redelivery, order linking, dates that never fall in the past).
 */
const CONTRACTS = resolve(import.meta.dirname, '../../contracts/messages');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const Ajv2020 = (Ajv2020Module as any).default ?? Ajv2020Module;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(readJson(resolve(CONTRACTS, 'envelope.schema.json')));
const topics = readdirSync(resolve(CONTRACTS, 'schemas'))
    .filter((file) => file.endsWith('.schema.json'))
    .map((file) => file.slice(0, -'.schema.json'.length));
for (const topic of topics) {
    ajv.addSchema(readJson(resolve(CONTRACTS, 'schemas', `${topic}.schema.json`)));
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fixtures = loadScenarios();
const NOW = new Date('2026-12-01T10:00:00Z');

describe('fixtures del simulador', () => {
    it('cada archivo se llama como su escenario y los nombres no se repiten', () => {
        const files = readdirSync(FIXTURES_DIR).filter((file) => file.endsWith('.json'));
        expect(fixtures.map((fixture) => `${fixture.scenario}.json`).sort()).toEqual(files.sort());
    });

    it('cubre los escenarios que pide ST-73.2', () => {
        const names = fixtures.map((fixture) => fixture.scenario);
        expect(names).toEqual(
            expect.arrayContaining([
                'complete-order',
                'out-of-order',
                'duplicate-message',
                'stale-version',
                'invalid-message',
                'unknown-warehouse',
                'cancellation',
                'address-change',
                'lost-delivery-data',
                'lost-shipment',
            ]),
        );
    });

    it('el pedido completo lleva confirmedAt y physicallyPacked', () => {
        const [confirmed, ready] = loadScenario('complete-order')!.steps.map(
            (step) => step.message['data'] as Record<string, unknown>,
        );
        expect(confirmed!['confirmedAt']).toBeTypeOf('string');
        expect(ready!['physicallyPacked']).toBe(true);
    });

    for (const fixture of fixtures) {
        describe(fixture.scenario, () => {
            it('tiene descripción, resultado esperado y al menos un mensaje', () => {
                expect(fixture.description).not.toBe('');
                expect(fixture.expected).not.toBe('');
                expect(fixture.steps.length).toBeGreaterThan(0);
            });

            for (const [index, step] of fixture.steps.entries()) {
                const topic = String(step.message['type']);
                it(`paso ${index + 1} (${topic}) ${step.expectInvalid ? 'incumple' : 'cumple'} su esquema`, () => {
                    const validate = ajv.getSchema(
                        `https://contracts.delivery-dispatch.local/messages/schemas/${topic}.schema.json`,
                    );
                    expect(validate, `sin esquema para ${topic}`).toBeDefined();
                    expect(validate!(step.message)).toBe(!step.expectInvalid);
                });
            }
        });
    }
});

describe('buildScenario', () => {
    const complete = loadScenario('complete-order')!;

    it('genera messageId UUID v7 nuevos en cada corrida', () => {
        const first = buildScenario(complete, { runId: 'aaaaaa', now: NOW });
        const second = buildScenario(complete, { runId: 'bbbbbb', now: NOW });
        const ids = [...first.steps, ...second.steps].map((step) => step.envelope['messageId']);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(UUID_V7);
    });

    it('sufija el pedido y los bultos con el runId, igual en todos los mensajes', () => {
        const built = buildScenario(complete, { runId: 'abc123', now: NOW });
        const orderIds = new Set(built.steps.map((step) => step.orderId));
        expect([...orderIds]).toHaveLength(1);
        expect([...orderIds][0]).toMatch(/^SO-SIM-\d{4}-abc123$/);
        const ready = built.steps[1]!.envelope['data'] as { packages: Array<{ packageId: string }> };
        expect(ready.packages[0]!.packageId).toContain('-abc123');
    });

    it('un reenvío conserva el mismo messageId y declara repeat', () => {
        const built = buildScenario(loadScenario('duplicate-message')!, { runId: 'abc123', now: NOW });
        expect(built.steps[0]!.repeat).toBe(2);
        expect(built.steps[0]!.envelope['messageId']).toMatch(UUID_V7);
    });

    it('si un mismo messageId fijo aparece en dos pasos, los dos conservan el mismo id nuevo', () => {
        const fixture = structuredClone(complete);
        fixture.steps[1]!.message['messageId'] = fixture.steps[0]!.message['messageId'];
        const built = buildScenario(fixture, { runId: 'abc123', now: NOW });
        expect(built.steps[1]!.envelope['messageId']).toBe(built.steps[0]!.envelope['messageId']);
    });

    it('desplaza las fechas para que el anchor sea «ahora» y conserva las distancias', () => {
        const built = buildScenario(complete, { runId: 'abc123', now: NOW });
        expect(built.steps[0]!.envelope['occurredAt']).toBe('2026-12-01T10:00:00Z');
        expect(built.steps[1]!.envelope['occurredAt']).toBe('2026-12-01T10:05:00Z');
    });

    it('la ventana de recogida queda en el futuro aunque el fixture sea viejo', () => {
        const built = buildScenario(loadScenario('pickup-requested')!, { runId: 'abc123', now: NOW });
        const window = (built.steps[0]!.envelope['data'] as { pickupWindow: { startsAt: string } }).pickupWindow;
        expect(Date.parse(window.startsAt)).toBeGreaterThan(NOW.getTime());
    });

    it('asIs deja ids y fechas tal como están en el fixture', () => {
        const built = buildScenario(complete, { asIs: true, now: NOW });
        expect(built.steps.map((step) => step.envelope)).toEqual(complete.steps.map((step) => step.message));
    });

    it('marca los pasos que esperan la solicitud de sincronización', () => {
        const marketplace = buildScenario(loadScenario('lost-delivery-data')!, { runId: 'abc123', now: NOW });
        expect(marketplace.steps.map((step) => step.respondsTo)).toEqual([undefined, 'sales_order']);
        const inventory = buildScenario(loadScenario('lost-shipment')!, { runId: 'abc123', now: NOW });
        expect(inventory.steps.map((step) => step.respondsTo)).toEqual([undefined, 'shipment']);
    });

    it('no valida: un mensaje inválido a propósito sale tal cual, solo con ids y fechas nuevos', () => {
        const built = buildScenario(loadScenario('invalid-message')!, { runId: 'abc123', now: NOW });
        expect(built.steps[0]!.expectInvalid).toBe(true);
        expect((built.steps[0]!.envelope['data'] as Record<string, unknown>)['recipient']).toBeUndefined();
    });
});
