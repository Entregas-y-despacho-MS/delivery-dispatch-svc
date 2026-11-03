import type { MutationOptions } from '../../../../shared/dto/options.dto.js';

/**
 * What is remembered per RMA (table `rma_sync_states`, migration 021). It is the single source of
 * truth of the highest `recordVersion` received for that `rmaId`.
 */
export interface RmaSyncState {
    rmaId: string;
    /** Last `recordVersion` applied for this RMA. `0` means nothing was received yet. */
    lastRecordVersion: number;
}

/**
 * Port of the per-RMA sync state. Every method takes `{ manager }` so it runs inside the
 * transaction opened by `InboundMessageTransaction.process`.
 */
export abstract class RmaSyncStatePort {
    /** The state of one RMA, or `null` if no row exists yet. */
    abstract find(rmaId: string, options?: MutationOptions): Promise<RmaSyncState | null>;

    /** Creates or updates the row of `rmaId`. */
    abstract save(state: RmaSyncState, options?: MutationOptions): Promise<void>;
}
