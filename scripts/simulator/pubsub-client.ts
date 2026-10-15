import { PubSub, type Topic } from '@google-cloud/pubsub';

/**
 * Pub/Sub access of the ERP simulator (ST-73.2). It only talks to the local emulator: pointing it at the
 * real Google Cloud would publish fake orders to a shared environment, so there is no way to opt out.
 */
const EMULATOR_HOST = process.env['PUBSUB_EMULATOR_HOST'] || 'localhost:8085';
const PROJECT_ID = process.env['PUBSUB_PROJECT_ID'] || 'delivery-dispatch-local';

// The client picks the emulator up from this variable; it must be set before it is created.
process.env['PUBSUB_EMULATOR_HOST'] = EMULATOR_HOST;

export const simulatorTarget = { emulatorHost: EMULATOR_HOST, projectId: PROJECT_ID };

export const pubsub = new PubSub({ projectId: PROJECT_ID });

export class SimulatorError extends Error {}

/** Resolves a topic, failing with a hint when the bootstrap of the emulator has not run. */
export async function requireTopic(name: string): Promise<Topic> {
    const topic = pubsub.topic(name);
    let exists: boolean;
    try {
        [exists] = await topic.exists();
    } catch (error) {
        throw new SimulatorError(
            `No se pudo consultar el emulador de Pub/Sub en ${EMULATOR_HOST}: ` +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Levántalo con `docker compose up` (raíz del workspace).',
        );
    }
    if (!exists) {
        throw new SimulatorError(
            `El tópico ${name} no existe en el emulador (${EMULATOR_HOST}). ` +
                'Créalo con `node scripts/pubsub/bootstrap.mjs` (o `docker compose up`).',
        );
    }
    return topic;
}

/** Publishes an envelope the same way the service does: JSON body plus the routing attributes. */
export async function publishEnvelope(
    topic: Topic,
    envelope: Record<string, unknown>,
): Promise<string> {
    const attributes: Record<string, string> = {};
    for (const key of ['messageId', 'type', 'source', 'schemaVersion']) {
        const value = envelope[key];
        if (value !== undefined) attributes[key] = String(value);
    }
    return await topic.publishMessage({ json: envelope, attributes });
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function closeClient(): Promise<void> {
    await pubsub.close();
}
