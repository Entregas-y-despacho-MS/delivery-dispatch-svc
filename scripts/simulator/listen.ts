import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Message, Subscription } from '@google-cloud/pubsub';
import {
    closeClient,
    pubsub,
    requireTopic,
    SimulatorError,
    simulatorTarget,
} from './pubsub-client.js';

/**
 * `npm run simulate:listen` (ST-73.2): the simulated consumer of the ERP. It subscribes to every topic
 * Despachos publishes (`dispatch.*`) and writes each message to the console, so what the outbox sends
 * can be observed without a real Marketplace, Almacén or Compras.
 *
 * Its subscription is its own (`<topic>.simulator-listen`): a message is delivered to it and to the
 * `simulate:*` responders independently, never split between them.
 */
const SCHEMAS_DIR = resolve(import.meta.dirname, '../../contracts/messages/schemas');
const SCHEMA_SUFFIX = '.schema.json';
const OUTBOUND_PREFIX = 'dispatch.';
const LISTEN_SUFFIX = 'simulator-listen';
const DEAD_LETTER_INSPECT = '.dead-letter.inspect';

const USAGE = `Uso: npm run simulate:listen -- [opciones]
  --topic <tópico>   escucha solo ese tópico de Despachos (repetible); por defecto, todos los dispatch.*
  --dead-letters     escucha también los dead-letter de los tópicos de entrada (<tópico>.dead-letter.inspect).
                     Ojo: confirma (ack) cada mensaje, así que deja de verse en esa suscripción de inspección.
  --help             muestra esta ayuda`;

const topicsFromContracts = (): string[] =>
    readdirSync(SCHEMAS_DIR)
        .filter((file) => file.endsWith(SCHEMA_SUFFIX))
        .map((file) => file.slice(0, -SCHEMA_SUFFIX.length))
        .sort();

function show(label: string, source: string, message: Message): void {
    const text = message.data.toString('utf8');
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        // Not JSON (a dead-lettered mix-up, for instance): print it raw.
    }
    const envelope = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    console.log(`\n[${new Date().toISOString()}] ${label} ${source}`);
    if (typeof envelope['messageId'] === 'string') {
        console.log(`  messageId=${envelope['messageId']} source=${String(envelope['source'])}`);
    }
    console.log(
        JSON.stringify(body, null, 2)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
    );
}

async function ensureSubscription(topicName: string): Promise<Subscription> {
    const topic = await requireTopic(topicName);
    const subscription = topic.subscription(`${topicName}.${LISTEN_SUFFIX}`);
    const [exists] = await subscription.exists();
    if (exists) return subscription;
    const [created] = await topic.createSubscription(`${topicName}.${LISTEN_SUFFIX}`);
    return created;
}

async function main(argv: string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            topic: { type: 'string', multiple: true },
            'dead-letters': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help) {
        console.log(USAGE);
        return 0;
    }

    const catalog = topicsFromContracts();
    const outbound = catalog.filter((topic) => topic.startsWith(OUTBOUND_PREFIX));
    const inbound = catalog.filter((topic) => !topic.startsWith(OUTBOUND_PREFIX));

    const requested = values.topic ?? [];
    const unknown = requested.filter((topic) => !outbound.includes(topic));
    if (unknown.length > 0) {
        console.error(`Tópico(s) que Despachos no publica: ${unknown.join(', ')}.`);
        console.error(`Disponibles: ${outbound.join(', ')}.`);
        return 2;
    }
    const topics = requested.length > 0 ? requested : outbound;

    console.log(`Emulador ${simulatorTarget.emulatorHost}, proyecto ${simulatorTarget.projectId}.`);
    const subscriptions: Subscription[] = [];

    for (const topicName of topics) {
        const subscription = await ensureSubscription(topicName);
        subscription.on('message', (message: Message) => {
            show('◀', topicName, message);
            message.ack();
        });
        subscription.on('error', (error: Error) => console.error(`${topicName}: ${error.message}`));
        subscriptions.push(subscription);
        console.log(`Escuchando ${topicName}`);
    }

    if (values['dead-letters']) {
        for (const topicName of inbound) {
            const name = `${topicName}${DEAD_LETTER_INSPECT}`;
            const subscription = pubsub.subscription(name);
            const [exists] = await subscription.exists();
            if (!exists) {
                console.warn(`Sin suscripción ${name}: ejecuta el bootstrap del emulador.`);
                continue;
            }
            subscription.on('message', (message: Message) => {
                show('☠ DEAD-LETTER', topicName, message);
                message.ack();
            });
            subscription.on('error', (error: Error) => console.error(`${name}: ${error.message}`));
            subscriptions.push(subscription);
            console.log(`Escuchando ${name}`);
        }
    }

    console.log('\nEsperando mensajes. Ctrl+C para salir.');
    await new Promise<void>((done) => {
        process.once('SIGINT', () => done());
        process.once('SIGTERM', () => done());
    });
    await Promise.allSettled(subscriptions.map((subscription) => subscription.close()));
    return 0;
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
