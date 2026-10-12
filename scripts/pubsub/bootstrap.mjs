// Crea en el emulador de Google Cloud Pub/Sub los tópicos, suscripciones y dead-letters del catálogo
// de docs/delivery-dispatch-docs/interoperabilidad-y-flujos.md (sección 1.4).
//
// Sin dependencias: usa la API REST del emulador con el `fetch` de Node. Los tópicos se derivan de los
// archivos `<tópico>.schema.json` de contracts/messages/schemas, que es la fuente única del catálogo.
// Es idempotente: crear algo que ya existe (409) no es un error.
//
// Variables de entorno:
//   PUBSUB_EMULATOR_HOST  host:puerto del emulador          (por defecto localhost:8085)
//   PUBSUB_PROJECT_ID     proyecto del emulador             (por defecto delivery-dispatch-local)
//   SCHEMAS_DIR           carpeta con los *.schema.json     (por defecto ../../contracts/messages/schemas)
//   PUBSUB_MAX_DELIVERY_ATTEMPTS  entregas antes del dead-letter (por defecto 5)

import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.PUBSUB_EMULATOR_HOST ?? 'localhost:8085';
const PROJECT = process.env.PUBSUB_PROJECT_ID ?? 'delivery-dispatch-local';
const SCHEMAS_DIR =
    process.env.SCHEMAS_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/messages/schemas');
const MAX_DELIVERY_ATTEMPTS = Number(process.env.PUBSUB_MAX_DELIVERY_ATTEMPTS ?? 5);

const SCHEMA_SUFFIX = '.schema.json';
/** Los tópicos que publica Despachos no tienen suscripción propia: la crea quien los consume. */
const OUTBOUND_PREFIX = 'dispatch.';
const SERVICE_SUBSCRIBER = 'dispatch-svc';
const DEAD_LETTER_SUFFIX = '.dead-letter';
const DEAD_LETTER_INSPECT = 'inspect';

const BASE_URL = `http://${HOST}/v1/projects/${PROJECT}`;
const topicPath = (topic) => `projects/${PROJECT}/topics/${topic}`;
const subscriptionPath = (name) => `projects/${PROJECT}/subscriptions/${name}`;

async function waitForEmulator(attempts = 30, delayMs = 1000) {
    for (let i = 1; i <= attempts; i++) {
        try {
            const res = await fetch(`http://${HOST}/`);
            if (res.ok) return;
        } catch {
            // el emulador todavía no acepta conexiones
        }
        await new Promise((done) => setTimeout(done, delayMs));
    }
    throw new Error(`El emulador de Pub/Sub no respondió en ${HOST} tras ${attempts} intentos.`);
}

/** PUT idempotente: 200 = creado, 409 = ya existía. */
async function put(url, body, label) {
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    if (res.status === 409) {
        console.log(`= ${label} (ya existe)`);
        return;
    }
    if (!res.ok) {
        throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
    }
    console.log(`+ ${label}`);
}

const createTopic = (topic) => put(`${BASE_URL}/topics/${topic}`, {}, `tópico ${topic}`);

const createSubscription = (name, topic, extra = {}) =>
    put(
        `${BASE_URL}/subscriptions/${name}`,
        { topic: topicPath(topic), ackDeadlineSeconds: 30, ...extra },
        `suscripción ${name}`,
    );

async function listTopics() {
    const files = await readdir(SCHEMAS_DIR);
    return files
        .filter((file) => file.endsWith(SCHEMA_SUFFIX))
        .map((file) => file.slice(0, -SCHEMA_SUFFIX.length))
        .sort();
}

async function main() {
    const topics = await listTopics();
    if (topics.length === 0) {
        throw new Error(`No hay esquemas en ${SCHEMAS_DIR}: no hay tópicos que crear.`);
    }

    console.log(`Emulador ${HOST}, proyecto ${PROJECT}, ${topics.length} tópicos.`);
    await waitForEmulator();

    for (const topic of topics) {
        await createTopic(topic);
        if (topic.startsWith(OUTBOUND_PREFIX)) continue;

        // Tópico de entrada: dead-letter propio (con una suscripción de inspección para retener los
        // rechazados) y la suscripción del servicio, que lo usa para los mensajes que el manejador no logra procesar.
        const deadLetter = `${topic}${DEAD_LETTER_SUFFIX}`;
        await createTopic(deadLetter);
        await createSubscription(`${deadLetter}.${DEAD_LETTER_INSPECT}`, deadLetter);
        await createSubscription(`${topic}.${SERVICE_SUBSCRIBER}`, topic, {
            deadLetterPolicy: {
                deadLetterTopic: topicPath(deadLetter),
                maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS,
            },
        });
    }

    console.log('Listo.');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
