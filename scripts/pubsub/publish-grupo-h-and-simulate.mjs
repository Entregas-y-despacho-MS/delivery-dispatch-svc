import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';
import { v7 as uuidv7 } from 'uuid';

const projectId = process.env.PUBSUB_PROJECT_ID ?? 'project-a96e5fe1-5ba6-4698-a85';
const inboundTopic = process.env.PUBSUB_INBOUND_TOPIC ?? 'ucb-sis323-sub-h';
const emulatorHost = process.env.LOCAL_PUBSUB_EMULATOR_HOST ?? 'localhost:8085';
const inputPath = process.argv[2];

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
        'Configura GOOGLE_APPLICATION_CREDENTIALS con la ruta del JSON de la cuenta de servicio que tiene permiso de publicación.',
    );
}

async function loadMessages() {
    if (inputPath) {
        const content = await readFile(inputPath, 'utf8');
        const parsed = JSON.parse(content);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        if (messages.length === 0) throw new Error('El archivo no contiene mensajes.');
        return messages;
    }

    const now = new Date();
    const occurredAt = now.toISOString();
    const salesOrderId = `SO-MANUAL-${now.getTime()}-${randomUUID().slice(0, 8)}`;
    return [
        {
            messageId: uuidv7(),
            type: 'marketplace.sales_order.confirmed',
            schemaVersion: 1,
            source: 'marketplace',
            occurredAt,
            data: {
                salesOrderId,
                recordVersion: 1,
                updatedAt: occurredAt,
                confirmedAt: new Date(now.getTime() - 60_000).toISOString(),
                recipient: { name: 'Cliente Prueba', phone: '+59170000000' },
                deliveryAddress: {
                    line: 'Dirección de prueba, La Paz',
                    location: { latitude: -16.5115, longitude: -68.1223 },
                },
                priority: 'normal',
            },
        },
        {
            messageId: uuidv7(),
            type: 'inventory.shipment.ready',
            schemaVersion: 1,
            source: 'inventory',
            occurredAt,
            data: {
                salesOrderId,
                recordVersion: 1,
                updatedAt: occurredAt,
                warehouseId: 'WH-LPZ-01',
                availableFrom: occurredAt,
                packages: [{
                    packageId: `${salesOrderId}-PKG-1`,
                    lengthCm: 40,
                    widthCm: 30,
                    heightCm: 25,
                    grossWeightKg: 6.4,
                }],
                handlingConditions: ['FRAGILE'],
                evidencePolicy: 'hand_delivery_standard',
                physicallyPacked: true,
            },
        },
    ];
}

function attributesOf(message) {
    return {
        messageId: String(message.messageId),
        type: String(message.type),
        source: String(message.source),
        schemaVersion: String(message.schemaVersion),
    };
}

const messages = await loadMessages();
const missingEnvelopeFields = messages.find((message) =>
    !message ||
    typeof message.messageId !== 'string' ||
    typeof message.type !== 'string' ||
    typeof message.source !== 'string' ||
    typeof message.schemaVersion !== 'number' ||
    typeof message.occurredAt !== 'string' ||
    typeof message.data !== 'object' || message.data === null,
);
if (missingEnvelopeFields) {
    throw new Error('Cada mensaje debe incluir messageId, type, source, schemaVersion, occurredAt y data.');
}

// Create the real GCP client before enabling the emulator variable for the local client.
delete process.env.PUBSUB_EMULATOR_HOST;
const gcp = new PubSub({ projectId });
process.env.PUBSUB_EMULATOR_HOST = emulatorHost;
const emulator = new PubSub({ projectId: 'delivery-dispatch-local' });

try {
    for (const message of messages) {
        const gcpMessageId = await gcp.topic(inboundTopic).publishMessage({
            json: message,
            attributes: attributesOf(message),
        });
        const orderId = message.data.salesOrderId ? `; pedido=${message.data.salesOrderId}` : '';
        console.log(`GCP: publicado ${message.type}${orderId}; broker=${gcpMessageId}`);

        // In the emulator the backend subscribes to each logical contract topic.
        const localMessageId = await emulator.topic(message.type).publishMessage({
            json: message,
            attributes: attributesOf(message),
        });
        console.log(`Emulador: copia enviada a ${message.type}${orderId}; broker=${localMessageId}`);
    }
    console.log(`Listo: ${messages.length} mensaje(s) publicados en ${inboundTopic} y copiados al backend local.`);
} finally {
    await Promise.all([gcp.close(), emulator.close()]);
}
