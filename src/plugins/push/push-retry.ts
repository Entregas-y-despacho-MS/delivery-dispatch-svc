import { PushPort, type PushMessage, type PushSendOutcome } from './push.port.js';

export const PUSH_SEND_MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;

/** Retries only temporary failures and keeps successful recipient sends out of subsequent attempts. */
export async function sendWithPushRetry(
    provider: PushPort,
    messages: PushMessage[],
    wait: (milliseconds: number) => Promise<void> = delay,
): Promise<PushSendOutcome[]> {
    const outcomes: PushSendOutcome[] = [];
    let pending = messages;

    for (let attempt = 1; pending.length > 0 && attempt <= PUSH_SEND_MAX_ATTEMPTS; attempt += 1) {
        let current: PushSendOutcome[];
        try {
            current = await provider.send(pending);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            current = pending.map(({ to }) => ({ token: to, status: 'retryable-error', error: detail }));
        }

        const byToken = new Map(current.map((outcome) => [outcome.token, outcome]));
        const retry: PushMessage[] = [];
        for (const message of pending) {
            const outcome = byToken.get(message.to);
            if (!outcome || outcome.status === 'retryable-error') {
                if (attempt < PUSH_SEND_MAX_ATTEMPTS) retry.push(message);
                else outcomes.push(outcome ?? {
                    token: message.to,
                    status: 'permanent-error',
                    error: 'Provider returned no outcome after the final attempt.',
                });
            } else {
                outcomes.push(outcome);
            }
        }

        pending = retry;
        if (pending.length > 0 && attempt < PUSH_SEND_MAX_ATTEMPTS) {
            await wait(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
        }
    }

    return outcomes;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
