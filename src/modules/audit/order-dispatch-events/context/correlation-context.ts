import { AsyncLocalStorage } from 'node:async_hooks';

/** The correlation id of the request being served, so a transition deep in a service can tag its event without plumbing. */
const storage = new AsyncLocalStorage<{ correlationId: string }>();

export const runWithCorrelationId = <T>(correlationId: string, fn: () => T): T => storage.run({ correlationId }, fn);

export const currentCorrelationId = (): string | undefined => storage.getStore()?.correlationId;
