import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DispatchChangeOutcome } from '../ports/existing-dispatch-changes.port.js';

/**
 * Internal domain event of the catalog (docs/interoperabilidad-y-flujos.md, section 3). The socket
 * layer (ST-53.2, `@OnEvent` in `app/`) re-emits it to the coordinators; this module only raises it.
 */
export const DISPATCH_CHANGE_REQUIRES_ATTENTION = 'dispatch.change_requires_attention';

/**
 * Raises the events that `ExistingDispatchChanges` returned. It must be called **after** the
 * transaction of the message committed, and never for a `duplicate`: an event about a change that
 * was rolled back would be a lie.
 */
@Injectable()
export class DispatchChangeEvents {
    private readonly logger = new Logger(DispatchChangeEvents.name);

    constructor(private readonly emitter: EventEmitter2) {}

    emitAfterCommit(outcomes: DispatchChangeOutcome[]): void {
        // One message can ask for attention twice (a package change and a readiness change); the
        // payload is the same, so the coordinators are told once. The detail of each lives in
        // `dispatch_events`.
        const emitted = new Set<string>();
        for (const outcome of outcomes) {
            if (outcome.status !== 'attention_required') continue;
            const key = JSON.stringify(outcome.event);
            if (emitted.has(key)) continue;
            emitted.add(key);
            try {
                this.emitter.emit(DISPATCH_CHANGE_REQUIRES_ATTENTION, outcome.event);
            } catch (error) {
                // The change is committed; a failing listener must not turn the message into a retry.
                this.logger.error(
                    `A listener of ${DISPATCH_CHANGE_REQUIRES_ATTENTION} failed for dispatch ` +
                        `${outcome.dispatchId}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }
}
