import { parseArgs } from 'node:util';
import type { Message, Subscription } from '@google-cloud/pubsub';
import type {
    BuiltScenario,
    BuiltStep,
    ScenarioFixture,
    SimulatorScript,
} from '../../test/simulator/scenario.types.js';
import { buildScenario, scenariosOf } from '../../test/simulator/scenarios.js';
import {
    closeClient,
    publishEnvelope,
    requireTopic,
    SimulatorError,
    simulatorTarget,
    sleep,
} from './pubsub-client.js';

/**
 * `npm run simulate:marketplace | simulate:inventory | simulate:procurement` (ST-73.2).
 *
 * Plays the ERP: publishes, to the emulator, the messages of a scenario of
 * `test/simulator/fixtures/`. Scenarios with a withheld message («mensaje perdido») stay subscribed to
 * `dispatch.sync.requested` and publish the complete record when Despachos asks for it.
 */
const SYNC_TOPIC = 'dispatch.sync.requested';
const SCRIPTS: SimulatorScript[] = ['marketplace', 'inventory', 'procurement'];

const USAGE = `Uso: npm run simulate:<origen> -- [opciones]
  --scenario <nombre>   escenario a ejecutar (sin opción: lista los disponibles)
  --all                 ejecuta todos los escenarios que no esperan una solicitud de sincronización
  --as-is               publica el fixture tal cual: mismos ids y fechas (suele ser ignorado por deduplicación)
  --run-id <texto>      sufijo de los ids de la corrida (por defecto, aleatorio)
  --delay <ms>          espera entre mensajes (300 por defecto)
  --timeout <minutos>   espera máxima de la solicitud de sincronización (120 por defecto)`;

const isWithheld = (step: BuiltStep): boolean => step.respondsTo !== undefined;

function describe(fixture: ScenarioFixture): string {
    const withheld = fixture.steps.some((step) => step.respondsTo !== undefined);
    return `  ${fixture.scenario.padEnd(24)} ${withheld ? '[espera dispatch.sync.requested] ' : ''}${fixture.description}`;
}

async function publishStep(step: BuiltStep): Promise<void> {
    const topic = await requireTopic(step.topic);
    for (let i = 1; i <= step.repeat; i++) {
        const brokerId = await publishEnvelope(topic, step.envelope);
        const suffix = step.repeat > 1 ? ` (entrega ${i}/${step.repeat})` : '';
        console.log(`  → ${step.topic}${suffix}`);
        console.log(`    ${step.label}`);
        console.log(`    messageId=${String(step.envelope['messageId'])} pedido=${step.orderId} broker=${brokerId}`);
    }
}

/** Waits for `dispatch.sync.requested` and publishes each withheld message when its order is asked for. */
async function answerSyncRequests(
    scenario: BuiltScenario,
    withheld: BuiltStep[],
    timeoutMinutes: number,
): Promise<boolean> {
    const syncTopic = await requireTopic(SYNC_TOPIC);
    // Own subscription: sharing one with `simulate:listen` would split the requests between them.
    const name = `${SYNC_TOPIC}.simulator-${scenario.runId}`;
    const [subscription] = await syncTopic.createSubscription(name);
    const pending = new Set(withheld);

    console.log(`\n  Esperando dispatch.sync.requested de ${withheld.map((s) => s.orderId).join(', ')}`);
    console.log('  (ST-50.5 lo emite cada 15 min tras `incomplete_order_alert_minutes`; ver README, «mensaje perdido»).');
    console.log('  Ctrl+C para cancelar.');

    return await new Promise<boolean>((resolve) => {
        let finished = false;
        let timer: NodeJS.Timeout;
        const finish = async (answered: boolean): Promise<void> => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            process.off('SIGINT', onSigint);
            await cleanup(subscription);
            resolve(answered);
        };
        const onSigint = (): void => {
            console.log('\n  Cancelado.');
            void finish(false);
        };
        process.on('SIGINT', onSigint);
        timer = setTimeout(() => {
            console.log(`\n  Sin solicitud tras ${timeoutMinutes} min: se cancela.`);
            void finish(false);
        }, timeoutMinutes * 60_000);

        subscription.on('message', (message: Message) => {
            message.ack();
            void (async () => {
                let request: { data?: { entityType?: string; entityId?: string; attempt?: number } };
                try {
                    request = JSON.parse(message.data.toString('utf8'));
                } catch {
                    return;
                }
                const data = request.data ?? {};
                const match = [...pending].find(
                    (step) => step.respondsTo === data.entityType && step.orderId === data.entityId,
                );
                if (match === undefined) return;
                console.log(
                    `\n  ← ${SYNC_TOPIC}: ${data.entityType} ${data.entityId} (solicitud ${data.attempt ?? '?'})`,
                );
                await publishStep(match);
                pending.delete(match);
                if (pending.size === 0) await finish(true);
            })().catch((error: unknown) => {
                console.error(`  Error al responder: ${error instanceof Error ? error.message : String(error)}`);
                void finish(false);
            });
        });
        subscription.on('error', (error: Error) => {
            console.error(`  Error de la suscripción: ${error.message}`);
            void finish(false);
        });
    });
}

async function cleanup(subscription: Subscription): Promise<void> {
    try {
        await subscription.close();
        await subscription.delete();
    } catch {
        // The emulator may already be gone; there is nothing else to clean.
    }
}

async function runScenario(
    fixture: ScenarioFixture,
    options: { runId?: string; asIs: boolean; delayMs: number; timeoutMinutes: number },
): Promise<boolean> {
    const scenario = buildScenario(fixture, { runId: options.runId, asIs: options.asIs });
    console.log(`\n▶ ${scenario.scenario} (corrida ${scenario.runId})`);
    console.log(`  ${scenario.description}`);

    const immediate = scenario.steps.filter((step) => !isWithheld(step));
    const withheld = scenario.steps.filter(isWithheld);

    // Subscribe before publishing anything so a fast `sync.requested` cannot be missed.
    const answered = withheld.length > 0 ? answerSyncRequests(scenario, withheld, options.timeoutMinutes) : null;
    for (const [index, step] of immediate.entries()) {
        if (index > 0) await sleep(options.delayMs);
        await publishStep(step);
    }
    const ok = answered === null ? true : await answered;
    console.log(`\n  Esperado: ${scenario.expected}`);
    return ok;
}

async function main(argv: string[]): Promise<number> {
    const script = argv[0] as SimulatorScript | undefined;
    if (script === undefined || !SCRIPTS.includes(script)) {
        console.error(`Origen desconocido. Usa uno de: ${SCRIPTS.join(', ')}.`);
        return 2;
    }

    const { values } = parseArgs({
        args: argv.slice(1),
        options: {
            scenario: { type: 'string' },
            all: { type: 'boolean', default: false },
            'as-is': { type: 'boolean', default: false },
            'run-id': { type: 'string' },
            delay: { type: 'string', default: '300' },
            timeout: { type: 'string', default: '120' },
            help: { type: 'boolean', default: false },
        },
    });

    const available = scenariosOf(script);
    if (values.help || (!values.scenario && !values.all)) {
        console.log(`${USAGE}\n\nEscenarios de ${script}:`);
        for (const fixture of available) console.log(describe(fixture));
        return 0;
    }

    const delayMs = Number(values.delay);
    const timeoutMinutes = Number(values.timeout);
    if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
        console.error('--delay y --timeout deben ser números positivos.');
        return 2;
    }

    const chosen = values.scenario
        ? available.filter((fixture) => fixture.scenario === values.scenario)
        : available.filter((fixture) => !fixture.steps.some((step) => step.respondsTo !== undefined));
    if (chosen.length === 0) {
        console.error(`No hay un escenario «${values.scenario}» para ${script}. Escenarios:`);
        for (const fixture of available) console.error(describe(fixture));
        return 2;
    }

    console.log(`Emulador ${simulatorTarget.emulatorHost}, proyecto ${simulatorTarget.projectId}.`);
    let failed = false;
    for (const fixture of chosen) {
        const ok = await runScenario(fixture, {
            runId: values['run-id'],
            asIs: values['as-is'],
            delayMs,
            timeoutMinutes,
        });
        failed ||= !ok;
    }
    return failed ? 1 : 0;
}

main(process.argv.slice(2))
    .catch((error: unknown) => {
        console.error(error instanceof SimulatorError || error instanceof Error ? error.message : error);
        return 1;
    })
    .then(async (code) => {
        await closeClient().catch(() => undefined);
        process.exit(code);
    });
