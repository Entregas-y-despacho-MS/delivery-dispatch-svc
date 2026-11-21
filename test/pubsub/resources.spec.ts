import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan, COMPLAINT_TOPICS, findProblems, topicOfSchemaFile, topicPath } from '../../scripts/pubsub/resources.mjs';

/**
 * Catálogo de recursos de Pub/Sub del entorno local (ST-298.4): qué crea el bootstrap y cómo detecta que
 * falta algo. La parte de red (el emulador) no se prueba aquí: se corre contra el emulador real.
 */
const PROJECT = 'delivery-dispatch-local';
const OPTIONS = {
    project: PROJECT,
    subscriber: 'dispatch-svc',
    maxDeliveryAttempts: 5,
    minBackoff: '10s',
    maxBackoff: '600s',
};
const SCHEMAS = resolve(import.meta.dirname, '../../contracts/messages/schemas');
const realTopics = (): string[] =>
    readdirSync(SCHEMAS)
        .map(topicOfSchemaFile)
        .filter((topic: string | undefined): topic is string => topic !== undefined);

/** Lo que el emulador devolvería si el bootstrap hubiera creado todo el plan. */
function createdBy(plan: ReturnType<typeof buildPlan>) {
    return {
        topics: new Set<string>(plan.topics),
        subscriptions: new Map<string, unknown>(
            plan.subscriptions.map((s: any) => [
                s.name,
                {
                    topic: topicPath(PROJECT, s.topic),
                    deadLetterPolicy: s.body.deadLetterPolicy,
                    retryPolicy: s.body.retryPolicy,
                },
            ]),
        ),
    };
}

describe('buildPlan', () => {
    const topics = realTopics();
    const plan = buildPlan(topics, OPTIONS);

    it('crea el tópico de entrada del reclamo con dead-letter, inspección y suscripción del servicio', () => {
        const input = 'crm.delivery_complaint.opened';
        expect(plan.topics).toEqual(expect.arrayContaining([input, `${input}.dead-letter`]));
        const names = plan.subscriptions.map((s: any) => s.name);
        expect(names).toEqual(expect.arrayContaining([`${input}.dead-letter.inspect`, `${input}.dispatch-svc`]));

        const service = plan.subscriptions.find((s: any) => s.name === `${input}.dispatch-svc`);
        expect(service.body.deadLetterPolicy).toEqual({
            deadLetterTopic: topicPath(PROJECT, `${input}.dead-letter`),
            maxDeliveryAttempts: 5,
        });
        expect(service.body.retryPolicy).toEqual({ minimumBackoff: '10s', maximumBackoff: '600s' });
    });

    it('crea los tópicos de acuse sin suscripción ni dead-letter propios', () => {
        for (const ack of ['dispatch.delivery_complaint.received', 'dispatch.delivery_complaint.rejected']) {
            expect(plan.topics).toContain(ack);
            expect(plan.topics).not.toContain(`${ack}.dead-letter`);
            expect(plan.subscriptions.some((s: any) => s.topic === ack)).toBe(false);
        }
    });

    it('lleva todos los tópicos de los esquemas y ningún nombre repetido', () => {
        for (const topic of topics) expect(plan.topics).toContain(topic);
        expect(new Set(plan.topics).size).toBe(plan.topics.length);
        expect(new Set(plan.subscriptions.map((s: any) => s.name)).size).toBe(plan.subscriptions.length);
    });

    it.each(COMPLAINT_TOPICS)('falla si falta el esquema de %s', (missing: string) => {
        expect(() =>
            buildPlan(
                topics.filter((topic) => topic !== missing),
                OPTIONS,
            ),
        ).toThrow(missing);
    });

    it('usa el sufijo de suscripción configurado', () => {
        const other = buildPlan(topics, { ...OPTIONS, subscriber: 'otro' });
        expect(other.subscriptions.map((s: any) => s.name)).toContain('crm.delivery_complaint.opened.otro');
    });
});

describe('findProblems', () => {
    const plan = buildPlan(realTopics(), OPTIONS);

    it('no encuentra problemas cuando está todo creado', () => {
        expect(findProblems(plan, createdBy(plan), PROJECT)).toEqual([]);
    });

    it('avisa de un tópico que falta', () => {
        const existing = createdBy(plan);
        existing.topics.delete('dispatch.delivery_complaint.received');
        expect(findProblems(plan, existing, PROJECT)).toEqual([
            'falta el tópico dispatch.delivery_complaint.received',
        ]);
    });

    it('avisa de una suscripción que falta', () => {
        const existing = createdBy(plan);
        existing.subscriptions.delete('crm.delivery_complaint.opened.dispatch-svc');
        expect(findProblems(plan, existing, PROJECT)).toEqual([
            'falta la suscripción crm.delivery_complaint.opened.dispatch-svc',
        ]);
    });

    it('avisa de una suscripción atada a otro tópico', () => {
        const existing = createdBy(plan);
        existing.subscriptions.set('crm.delivery_complaint.opened.dispatch-svc', {
            ...(existing.subscriptions.get('crm.delivery_complaint.opened.dispatch-svc') as object),
            topic: topicPath(PROJECT, 'inventory.receipt.confirmed'),
        });
        const problems = findProblems(plan, existing, PROJECT);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('apunta a');
    });

    it('avisa de una suscripción sin dead-letter', () => {
        const existing = createdBy(plan);
        existing.subscriptions.set('crm.delivery_complaint.opened.dispatch-svc', {
            ...(existing.subscriptions.get('crm.delivery_complaint.opened.dispatch-svc') as object),
            deadLetterPolicy: undefined,
        });
        expect(findProblems(plan, existing, PROJECT)).toEqual([
            'la suscripción crm.delivery_complaint.opened.dispatch-svc no manda sus fallos a crm.delivery_complaint.opened.dead-letter',
        ]);
    });

    it('avisa de un número de entregas distinto del esperado', () => {
        const existing = createdBy(plan);
        existing.subscriptions.set('crm.delivery_complaint.opened.dispatch-svc', {
            ...(existing.subscriptions.get('crm.delivery_complaint.opened.dispatch-svc') as object),
            deadLetterPolicy: {
                deadLetterTopic: topicPath(PROJECT, 'crm.delivery_complaint.opened.dead-letter'),
                maxDeliveryAttempts: 100,
            },
        });
        const problems = findProblems(plan, existing, PROJECT);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('100');
    });

    it('avisa de una suscripción existente sin espera entre reentregas (se agotarían en milisegundos)', () => {
        const existing = createdBy(plan);
        const name = 'crm.delivery_complaint.opened.dispatch-svc';
        existing.subscriptions.set(name, {
            ...(existing.subscriptions.get(name) as object),
            retryPolicy: undefined,
        });
        const problems = findProblems(plan, existing, PROJECT);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('espera entre reentregas');
    });

    it('avisa de una espera distinta de la esperada', () => {
        const existing = createdBy(plan);
        const name = 'crm.delivery_complaint.opened.dispatch-svc';
        existing.subscriptions.set(name, {
            ...(existing.subscriptions.get(name) as object),
            retryPolicy: { minimumBackoff: '1s', maximumBackoff: '600s' },
        });
        expect(findProblems(plan, existing, PROJECT)).toHaveLength(1);
    });

    it('lista todos los problemas, no solo el primero', () => {
        const problems = findProblems(plan, { topics: new Set(), subscriptions: new Map() }, PROJECT);
        expect(problems).toHaveLength(plan.topics.length + plan.subscriptions.length);
    });
});

describe('topicOfSchemaFile', () => {
    it('devuelve el tópico de un esquema y nada para otros archivos', () => {
        expect(topicOfSchemaFile('crm.delivery_complaint.opened.schema.json')).toBe('crm.delivery_complaint.opened');
        expect(topicOfSchemaFile('README.md')).toBeUndefined();
    });
});
