import { randomBytes } from 'node:crypto';
import type { Message, Subscription } from '@google-cloud/pubsub';
import {
    deadLetteredMessageId,
    judgeAck,
    judgeStep,
    parseAck,
    RECEIVED_TOPIC,
    REJECTED_TOPIC,
    type ObservedAck,
} from '../../test/simulator/complaint-acks.js';
import type { BuiltScenario, BuiltStep } from '../../test/simulator/scenario.types.js';
import { publishEnvelope, requireTopic, sleep } from './pubsub-client.js';

/**
 * Plays CRM and observes the answer (ST-298.4). For each step it publishes the complaint to
 * `crm.delivery_complaint.opened` and waits for the acknowledgement the scenario expects on
 * `dispatch.delivery_complaint.received|rejected`, matched by `correlationMessageId`. A step that is invalid on
 * purpose must also reach the dead-letter topic. No dashboard: one verdict line per step.
 *
 * It uses subscriptions of its own (`<topic>.simulator-crm-<random>`), deleted at the end: it never takes a
 * message away from `simulate:listen` or from the service.
 */
const DEAD_LETTER_SUFFIX = '.dead-letter';
/** How long a step that must get NO acknowledgement is watched before it is declared quiet. */
const QUIET_MS = 5_000;
/** After the first acknowledgement, time given to a second one that should not exist. */
const SETTLE_MS = 1_500;
const POLL_MS = 100;

export interface ObserverOptions {
    delayMs: number;
    ackTimeoutSeconds: number;
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await sleep(POLL_MS);
    }
    return condition();
}

async function listen(
    topicName: string,
    suffix: string,
    onMessage: (raw: string) => void,
    created: Subscription[],
): Promise<void> {
    const topic = await requireTopic(topicName);
    const [subscription] = await topic.createSubscription(`${topicName}.simulator-crm-${suffix}`);
    created.push(subscription);
    subscription.on('message', (message: Message) => {
        message.ack();
        onMessage(message.data.toString('utf8'));
    });
    subscription.on('error', (error: Error) => {
        console.error(`  Error de la suscripción a ${topicName}: ${error.message}`);
    });
}

/** Closes and deletes a temporary subscription; a failed close must not leave it behind, so each is tried apart. */
async function dispose(subscription: Subscription): Promise<void> {
    for (const [what, action] of [
        ['cerrar', () => subscription.close()],
        ['borrar', () => subscription.delete()],
    ] as const) {
        try {
            await action();
        } catch (error) {
            console.error(
                `  No se pudo ${what} la suscripción ${subscription.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

/** Publishes the scenario and prints one verdict per step. `true` when every step got what it expected. */
export async function runComplaintScenario(scenario: BuiltScenario, options: ObserverOptions): Promise<boolean> {
    const suffix = randomBytes(4).toString('hex');
    const acks: ObservedAck[] = [];
    const deadLettered = new Set<string>();
    const subscriptions: Subscription[] = [];
    const inputTopics = [...new Set(scenario.steps.map((step) => step.topic))];

    // Ctrl+C must not leave the temporary subscriptions behind: they never ack and would pile up acknowledgements.
    const onSigint = (): void => {
        console.log('\n  Cancelado: se borran las suscripciones temporales.');
        void Promise.allSettled(subscriptions.map(dispose)).then(() => process.exit(130));
    };
    process.once('SIGINT', onSigint);

    try {
        // Subscribe before publishing anything: an acknowledgement that arrives first must not be missed.
        for (const topicName of [RECEIVED_TOPIC, REJECTED_TOPIC]) {
            await listen(
                topicName,
                suffix,
                (raw) => {
                    const ack = parseAck(raw);
                    if (ack !== undefined) acks.push(ack);
                },
                subscriptions,
            );
        }
        for (const topicName of inputTopics) {
            await listen(
                `${topicName}${DEAD_LETTER_SUFFIX}`,
                suffix,
                (raw) => {
                    const messageId = deadLetteredMessageId(raw);
                    if (messageId !== undefined) deadLettered.add(messageId);
                },
                subscriptions,
            );
        }

        let allOk = true;
        let answeredBefore = false;
        const settled: Array<{ step: BuiltStep; ok: boolean }> = [];
        for (const [index, step] of scenario.steps.entries()) {
            if (index > 0) await sleep(options.delayMs);
            const ok = await runStep(step, acks, deadLettered, options, answeredBefore);
            // «Answered» means a real acknowledgement came back, not that a step expecting silence stayed quiet.
            answeredBefore ||= ok && step.expectAck?.outcome !== 'ignored';
            settled.push({ step, ok });
            allOk &&= ok;
        }

        // A late acknowledgement (outbox retries, a slow service) can arrive after its step was judged: look again at
        // everything once the whole run is over, so a «quiet» or «single» acknowledgement is not just a short wait.
        await sleep(SETTLE_MS);
        for (const { step, ok } of settled) {
            const again = judgeAck(
                step.expectAck!,
                acks.filter((ack) => ack.correlationMessageId === String(step.envelope['messageId'])),
            );
            if (ok && !again.ok) {
                console.log(`    ✘ acuse tardío de «${step.label}»: ${again.summary}`);
                allOk = false;
            }
        }
        console.log(`\n  ${allOk ? '✔ Todos los pasos recibieron lo esperado.' : '✘ Algún paso no recibió lo esperado.'}`);
        return allOk;
    } finally {
        process.off('SIGINT', onSigint);
        await Promise.allSettled(subscriptions.map(dispose));
    }
}

async function runStep(
    step: BuiltStep,
    acks: ObservedAck[],
    deadLettered: Set<string>,
    options: ObserverOptions,
    answeredBefore: boolean,
): Promise<boolean> {
    const expected = step.expectAck;
    if (expected === undefined) {
        throw new Error(`El paso «${step.label}» no declara el acuse esperado (expectAck): no se puede observar.`);
    }
    const messageId = String(step.envelope['messageId']);
    const topic = await requireTopic(step.topic);
    for (let i = 1; i <= step.repeat; i++) {
        const brokerId = await publishEnvelope(topic, step.envelope);
        console.log(`  → ${step.topic}${step.repeat > 1 ? ` (entrega ${i}/${step.repeat})` : ''}`);
        console.log(`    ${step.label}`);
        console.log(`    messageId=${messageId} caso=${step.orderId} broker=${brokerId}`);
    }

    const mine = (): ObservedAck[] => acks.filter((ack) => ack.correlationMessageId === messageId);
    if (expected.outcome === 'ignored') {
        await sleep(QUIET_MS);
    } else if (await waitUntil(() => mine().length > 0, options.ackTimeoutSeconds * 1000)) {
        await sleep(SETTLE_MS);
    }
    const verdict = judgeStep(expected, mine(), { answeredBefore });
    console.log(`    ${verdict.ok ? '✔' : '✘'} acuse: ${verdict.summary}`);
    let ok = verdict.ok;

    if (step.expectInvalid) {
        const arrived = await waitUntil(() => deadLettered.has(messageId), options.ackTimeoutSeconds * 1000);
        console.log(
            `    ${arrived ? '✔' : '✘'} dead-letter: ${arrived ? 'el mensaje inválido llegó' : 'no llegó el mensaje inválido'}`,
        );
        ok &&= arrived;
    }
    return ok;
}
