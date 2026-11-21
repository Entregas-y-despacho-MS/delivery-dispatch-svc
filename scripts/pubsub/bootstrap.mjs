// Crea en el emulador de Google Cloud Pub/Sub los tópicos, suscripciones y dead-letters del catálogo
// de docs/delivery-dispatch-docs/interoperabilidad-y-flujos.md (sección 1.4).
//
// Sin dependencias: usa la API REST del emulador con el `fetch` de Node. Los tópicos se derivan de los
// archivos `<tópico>.schema.json` de contracts/messages/schemas, que es la fuente única del catálogo.
// Es idempotente: crear algo que ya existe (409) no es un error. Al terminar valida que cada recurso exista
// (y que las suscripciones apunten a su tópico y a su dead-letter); si falta algo, sale con error.
// `--check` solo valida, sin crear nada.
//
// Variables de entorno:
//   PUBSUB_EMULATOR_HOST  host:puerto del emulador          (por defecto localhost:8085)
//   PUBSUB_PROJECT_ID     proyecto del emulador             (por defecto delivery-dispatch-local)
//   SCHEMAS_DIR           carpeta con los *.schema.json     (por defecto ../../contracts/messages/schemas)
//   PUBSUB_MAX_DELIVERY_ATTEMPTS  entregas antes del dead-letter (por defecto 5)
//   PUBSUB_SUBSCRIPTION_SUFFIX    sufijo de la suscripción del servicio (por defecto dispatch-svc)
//   PUBSUB_MIN_BACKOFF / PUBSUB_MAX_BACKOFF  espera entre reentregas de un mensaje cuyo manejador falló (10s / 600s)

import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, findProblems, topicOfSchemaFile, topicPath } from './resources.mjs';

const HOST = process.env.PUBSUB_EMULATOR_HOST ?? 'localhost:8085';
const PROJECT = process.env.PUBSUB_PROJECT_ID ?? 'delivery-dispatch-local';
const SCHEMAS_DIR =
    process.env.SCHEMAS_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/messages/schemas');
const MAX_DELIVERY_ATTEMPTS = Number(process.env.PUBSUB_MAX_DELIVERY_ATTEMPTS ?? 5);
const SERVICE_SUBSCRIBER = process.env.PUBSUB_SUBSCRIPTION_SUFFIX ?? 'dispatch-svc';
// Sin retryPolicy el broker reentrega de inmediato y las entregas se agotan en milisegundos: una caída
// breve de la base de datos mandaría al dead-letter mensajes válidos.
const MIN_BACKOFF = process.env.PUBSUB_MIN_BACKOFF ?? '10s';
const MAX_BACKOFF = process.env.PUBSUB_MAX_BACKOFF ?? '600s';
const CHECK_ONLY = process.argv.includes('--check');

const BASE_URL = `http://${HOST}/v1/projects/${PROJECT}`;

async function waitForEmulator(attempts = 30, delayMs = 1000) {
    for (let i = 1; i <= attempts; i++) {
        try {
            // El emulador contesta «Ok» en la raíz. Cualquier otra cosa (p. ej. otro programa que ya usa el
            // puerto y contesta con una redirección) no es el emulador: crear recursos ahí «funcionaría» sin crear nada.
            const res = await fetch(`http://${HOST}/`, { redirect: 'manual' });
            if (res.ok && (await res.text()).trim() === 'Ok') return;
            if (res.status >= 300) {
                throw new Error(`${HOST} responde HTTP ${res.status}: no es el emulador de Pub/Sub (¿otro programa usa el puerto?).`);
            }
        } catch (error) {
            if (error instanceof Error && error.message.startsWith(HOST)) throw error;
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

/** GET que devuelve el recurso o `undefined` si no existe (404). */
async function get(url, label) {
    const res = await fetch(url);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
    return await res.json();
}

async function listTopics() {
    const files = await readdir(SCHEMAS_DIR);
    return files.map(topicOfSchemaFile).filter((topic) => topic !== undefined);
}

async function create(plan) {
    for (const topic of plan.topics) {
        await put(`${BASE_URL}/topics/${topic}`, {}, `tópico ${topic}`);
    }
    for (const subscription of plan.subscriptions) {
        await put(
            `${BASE_URL}/subscriptions/${subscription.name}`,
            { topic: topicPath(PROJECT, subscription.topic), ackDeadlineSeconds: 30, ...subscription.body },
            `suscripción ${subscription.name}`,
        );
    }
}

async function verify(plan) {
    const existing = { topics: new Set(), subscriptions: new Map() };
    for (const topic of plan.topics) {
        if ((await get(`${BASE_URL}/topics/${topic}`, `tópico ${topic}`)) !== undefined) existing.topics.add(topic);
    }
    for (const { name } of plan.subscriptions) {
        const found = await get(`${BASE_URL}/subscriptions/${name}`, `suscripción ${name}`);
        if (found !== undefined) existing.subscriptions.set(name, found);
    }
    return findProblems(plan, existing, PROJECT);
}

async function main() {
    const topics = await listTopics();
    if (topics.length === 0) {
        throw new Error(`No hay esquemas en ${SCHEMAS_DIR}: no hay tópicos que crear.`);
    }
    const plan = buildPlan(topics, {
        project: PROJECT,
        subscriber: SERVICE_SUBSCRIBER,
        maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS,
        minBackoff: MIN_BACKOFF,
        maxBackoff: MAX_BACKOFF,
    });

    console.log(`Emulador ${HOST}, proyecto ${PROJECT}, ${topics.length} tópicos${CHECK_ONLY ? ' (solo validación)' : ''}.`);
    await waitForEmulator();
    if (!CHECK_ONLY) await create(plan);

    const problems = await verify(plan);
    if (problems.length > 0) {
        throw new Error(`Recursos de Pub/Sub incompletos:${problems.map((problem) => `\n- ${problem}`).join('')}`);
    }
    console.log(`Validado: ${plan.topics.length} tópicos y ${plan.subscriptions.length} suscripciones.`);
    console.log('Listo.');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
