import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateMessageId } from '../../src/plugins/messaging/envelope/uuid-v7.js';
import type {
    BuildOptions,
    BuiltScenario,
    BuiltStep,
    ScenarioFixture,
    SimulatorScript,
} from './scenario.types.js';

/**
 * Content of the ERP simulator scenarios (ST-73.2). It is pure data + a pure builder: the
 * `scripts/simulator/` commands publish what it builds and the scenario tests feed it to the real
 * consumers, so both exercise exactly the same messages.
 */
export const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ORDER_ID_KEYS = ['salesOrderId', 'purchaseOrderId'] as const;

export function loadScenarios(dir: string = FIXTURES_DIR): ScenarioFixture[] {
    return readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as ScenarioFixture);
}

export function loadScenario(name: string, dir: string = FIXTURES_DIR): ScenarioFixture | undefined {
    return loadScenarios(dir).find((fixture) => fixture.scenario === name);
}

export function scenariosOf(script: SimulatorScript, dir: string = FIXTURES_DIR): ScenarioFixture[] {
    return loadScenarios(dir).filter((fixture) => fixture.script === script);
}

/** Short random suffix that makes the ids of one run unique (the order ids are limited to 64 chars). */
export function newRunId(): string {
    return randomBytes(3).toString('hex');
}

function shiftDate(value: string, deltaMs: number): string {
    return new Date(Date.parse(value) + deltaMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
    if (typeof value === 'string') return map(value);
    if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]),
        );
    }
    return value;
}

function orderIdOf(message: Record<string, unknown>): string {
    const data = (message['data'] ?? {}) as Record<string, unknown>;
    for (const key of ORDER_ID_KEYS) {
        if (typeof data[key] === 'string') return data[key];
    }
    return '';
}

/**
 * Turns a fixture into what a run publishes: fresh `messageId`s (the same fixed id keeps the same new
 * one, so a repeated step is still a redelivery), order ids suffixed with the run, and every date
 * shifted so the fixture's `anchor` becomes "now". `asIs` skips all of it.
 */
export function buildScenario(fixture: ScenarioFixture, options: BuildOptions = {}): BuiltScenario {
    const runId = options.runId ?? newRunId();
    const asIs = options.asIs === true;
    const deltaMs = (options.now ?? new Date()).getTime() - Date.parse(fixture.anchor);

    const orderIds = new Set(fixture.steps.map((step) => orderIdOf(step.message)).filter(Boolean));
    const messageIds = new Map<string, string>();
    const messageIdFor = (fixed: string): string => {
        let fresh = messageIds.get(fixed);
        if (fresh === undefined) {
            fresh = generateMessageId();
            messageIds.set(fixed, fresh);
        }
        return fresh;
    };

    const steps: BuiltStep[] = fixture.steps.map((step) => {
        let envelope = step.message;
        if (!asIs) {
            envelope = mapStrings(envelope, (text) => {
                if (ISO_UTC.test(text)) return shiftDate(text, deltaMs);
                // Substring, not equality: package ids embed the order id and must be unique per run too.
                let result = text;
                for (const orderId of orderIds) result = result.replaceAll(orderId, `${orderId}-${runId}`);
                return result;
            }) as Record<string, unknown>;
            if (typeof envelope['messageId'] === 'string') {
                envelope = { ...envelope, messageId: messageIdFor(envelope['messageId']) };
            }
        }
        return {
            label: step.label,
            topic: String(envelope['type']),
            envelope,
            repeat: step.repeat ?? 1,
            respondsTo: step.respondsTo,
            expectInvalid: step.expectInvalid === true,
            orderId: orderIdOf(envelope),
        };
    });

    return {
        scenario: fixture.scenario,
        script: fixture.script,
        description: fixture.description,
        expected: fixture.expected,
        runId: asIs ? 'as-is' : runId,
        steps,
    };
}
