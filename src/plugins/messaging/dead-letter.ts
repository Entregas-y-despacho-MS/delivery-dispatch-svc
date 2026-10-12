import type { MessageValidationError } from './envelope/message-validator.js';

export const DEAD_LETTER_SUFFIX = '.dead-letter';

/** Dead-letter topic of an incoming topic (created by scripts/pubsub/bootstrap.mjs). */
export function deadLetterTopicFor(topic: string): string {
    return `${topic}${DEAD_LETTER_SUFFIX}`;
}

/** What is published to a dead-letter topic: the rejected message untouched plus why it was rejected. */
export interface DeadLetterPayload {
    originalTopic: string;
    rejectedAt: string;
    errors: MessageValidationError[];
    /** The message exactly as it arrived (it may not even be an object). */
    message: unknown;
}

export function buildDeadLetterPayload(
    topic: string,
    message: unknown,
    errors: MessageValidationError[],
    rejectedAt: Date = new Date(),
): DeadLetterPayload {
    return { originalTopic: topic, rejectedAt: rejectedAt.toISOString(), errors, message };
}
