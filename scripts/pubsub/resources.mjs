// Catálogo de recursos de Pub/Sub que necesita Despachos, sin tocar la red: `bootstrap.mjs` lo usa para
// crearlos y para validarlos, y las pruebas lo ejercitan solas. Sin dependencias.

export const SCHEMA_SUFFIX = '.schema.json';
/** Los tópicos que publica Despachos no tienen suscripción propia: la crea quien los consume. */
export const OUTBOUND_PREFIX = 'dispatch.';
export const DEAD_LETTER_SUFFIX = '.dead-letter';
export const DEAD_LETTER_INSPECT = 'inspect';

/**
 * Tópicos sin los que el circuito del reclamo de CRM (ES-298) no cierra: el de entrada y los dos acuses.
 * Salen de `contracts/messages/schemas`; si falta un esquema, el bootstrap falla en vez de omitirlos.
 */
export const COMPLAINT_TOPICS = [
    'crm.delivery_complaint.opened',
    'dispatch.delivery_complaint.received',
    'dispatch.delivery_complaint.rejected',
];

export const topicPath = (project, topic) => `projects/${project}/topics/${topic}`;

/** Nombre de tópico a partir de un archivo `<tópico>.schema.json`; `undefined` si no es un esquema. */
export function topicOfSchemaFile(file) {
    return file.endsWith(SCHEMA_SUFFIX) ? file.slice(0, -SCHEMA_SUFFIX.length) : undefined;
}

/**
 * Qué debe existir para los tópicos dados. `topics` va primero (una suscripción necesita su tópico y, si
 * lo tiene, el dead-letter); `subscriptions` lleva lo que el emulador debe devolver al consultarlas.
 *
 * @param {string[]} topics tópicos lógicos (uno por esquema)
 * @param {{ project: string, subscriber: string, maxDeliveryAttempts: number, minBackoff: string, maxBackoff: string }} options
 */
export function buildPlan(topics, options) {
    const { project, subscriber, maxDeliveryAttempts, minBackoff, maxBackoff } = options;
    const missing = COMPLAINT_TOPICS.filter((topic) => !topics.includes(topic));
    if (missing.length > 0) {
        throw new Error(
            `Faltan los esquemas del reclamo de CRM: ${missing.join(', ')}. ` +
                'Sin ellos no se crean sus tópicos y el acuse nunca se entrega.',
        );
    }

    const planTopics = [];
    const subscriptions = [];
    for (const topic of [...topics].sort()) {
        planTopics.push(topic);
        if (topic.startsWith(OUTBOUND_PREFIX)) continue;

        const deadLetter = `${topic}${DEAD_LETTER_SUFFIX}`;
        planTopics.push(deadLetter);
        subscriptions.push({
            name: `${deadLetter}.${DEAD_LETTER_INSPECT}`,
            topic: deadLetter,
            body: {},
        });
        subscriptions.push({
            name: `${topic}.${subscriber}`,
            topic,
            deadLetterTopic: deadLetter,
            maxDeliveryAttempts,
            body: {
                retryPolicy: { minimumBackoff: minBackoff, maximumBackoff: maxBackoff },
                deadLetterPolicy: {
                    deadLetterTopic: topicPath(project, deadLetter),
                    maxDeliveryAttempts,
                },
            },
        });
    }
    return { topics: planTopics, subscriptions };
}

/**
 * Compara el plan con lo que existe. `existing.topics` es un Set de nombres; `existing.subscriptions` un Map
 * nombre → recurso del emulador (`{ topic, deadLetterPolicy }`). Devuelve una frase por problema.
 */
export function findProblems(plan, existing, project) {
    const problems = [];
    for (const topic of plan.topics) {
        if (!existing.topics.has(topic)) problems.push(`falta el tópico ${topic}`);
    }
    for (const expected of plan.subscriptions) {
        const actual = existing.subscriptions.get(expected.name);
        if (actual === undefined) {
            problems.push(`falta la suscripción ${expected.name}`);
            continue;
        }
        if (actual.topic !== topicPath(project, expected.topic)) {
            problems.push(
                `la suscripción ${expected.name} apunta a ${actual.topic}, se esperaba ${topicPath(project, expected.topic)}`,
            );
        }
        if (expected.deadLetterTopic === undefined) continue;
        const policy = actual.deadLetterPolicy;
        if (policy?.deadLetterTopic !== topicPath(project, expected.deadLetterTopic)) {
            problems.push(`la suscripción ${expected.name} no manda sus fallos a ${expected.deadLetterTopic}`);
        } else if (policy.maxDeliveryAttempts !== expected.maxDeliveryAttempts) {
            problems.push(
                `la suscripción ${expected.name} permite ${policy.maxDeliveryAttempts ?? 'sin límite de'} entregas, se esperaban ${expected.maxDeliveryAttempts}`,
            );
        }
    }
    return problems;
}
