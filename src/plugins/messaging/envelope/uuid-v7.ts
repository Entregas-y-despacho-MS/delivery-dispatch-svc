import { v7 } from 'uuid';

/** New time-ordered UUID v7 to use as `messageId` (idempotency key of a message). */
export function generateMessageId(): string {
    return v7();
}
