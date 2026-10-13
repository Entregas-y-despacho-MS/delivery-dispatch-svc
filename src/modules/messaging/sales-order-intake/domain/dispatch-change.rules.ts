import type {
    OrderDeliveryAddress,
    OrderPreferences,
    OrderPriority,
    OrderRecipient,
} from './marketplace-order.types.js';

/**
 * Rules for a change that arrives for an order that already is a dispatch (ST-72.2 and ST-72.1).
 * Pure: they decide what to do from the status of the dispatch and touch nothing.
 *
 * - `pending`, `address_review`, `in_planning`: the promise was not made yet, so the dispatch is
 *   updated (and taken out of the proposed batch if it was in one).
 * - `cancelled`: nothing to do.
 * - anything else (`scheduled`, `assigned` and later): the dispatch is not modified; the coordinator
 *   decides, so a `dispatch.change_requires_attention` event is raised.
 */

export type StatusClass = 'editable' | 'cancelled' | 'beyond_promise';

const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['pending', 'address_review', 'in_planning']);

export function classifyDispatchStatus(statusName: string): StatusClass {
    if (EDITABLE_STATUSES.has(statusName)) return 'editable';
    if (statusName === 'cancelled') return 'cancelled';
    return 'beyond_promise';
}

/** The columns of `dispatches` that a delivery change can touch, as the rules need to read them. */
export interface DispatchSnapshot {
    dispatchId: number;
    status: string;
    routeBatchId: number | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    deliveryAddress: string;
    deliveryReference: string | null;
    deliveryLatitude: number | null;
    deliveryLongitude: number | null;
    deliveryZoneId: number | null;
    priority: string;
    shipmentReady: boolean;
}

/** Blocks of an `updated` (or a later `confirmed`) of Marketplace that can reach a dispatch. */
export interface DeliveryChangeBlocks {
    recipient?: OrderRecipient;
    deliveryAddress?: OrderDeliveryAddress;
    priority?: OrderPriority;
    /** No column in `dispatches`: they only make the change count as a change. */
    preferences?: OrderPreferences;
    deliveryDeadline?: string;
}

export type ColumnChanges = Partial<
    Pick<
        DispatchSnapshot,
        | 'contactName'
        | 'contactPhone'
        | 'contactEmail'
        | 'deliveryAddress'
        | 'deliveryReference'
        | 'deliveryLatitude'
        | 'deliveryLongitude'
        | 'priority'
    >
>;

export type FieldDiff = Record<string, { from: unknown; to: unknown }>;

export type DeliveryChangePlan =
    | { kind: 'ignore'; reason: 'dispatch_cancelled' }
    | { kind: 'attention'; changedBlocks: string[] }
    | {
          kind: 'update';
          /** Only the columns whose value actually changes. */
          columns: ColumnChanges;
          diff: FieldDiff;
          changedBlocks: string[];
          /** The address block was sent, so the zone must be looked up again. */
          locationChanged: boolean;
          removeFromProposal: boolean;
      };

export type CancellationPlan =
    | { kind: 'ignore'; reason: 'dispatch_cancelled' }
    | { kind: 'attention' }
    | { kind: 'cancel'; removeFromProposal: boolean };

export type ReadinessPlan =
    | { kind: 'ignore'; reason: 'dispatch_cancelled' }
    | { kind: 'noop' }
    | { kind: 'attention' }
    | { kind: 'set'; ready: boolean; removeFromProposal: boolean };

const BLOCK_NAMES = ['recipient', 'deliveryAddress', 'priority', 'preferences', 'deliveryDeadline'] as const;

function presentBlocks(blocks: DeliveryChangeBlocks): string[] {
    return BLOCK_NAMES.filter((name) => blocks[name] !== undefined);
}

/** Coordinates that can be used to find a zone. Same bounds as the dispatch generator. */
export function isUsableLocation(location: OrderDeliveryAddress['location']): location is { latitude: number; longitude: number } {
    return (
        location !== undefined &&
        Number.isFinite(location.latitude) &&
        Math.abs(location.latitude) <= 90 &&
        Number.isFinite(location.longitude) &&
        Math.abs(location.longitude) <= 180
    );
}

export function planDeliveryChange(snapshot: DispatchSnapshot, blocks: DeliveryChangeBlocks): DeliveryChangePlan {
    const statusClass = classifyDispatchStatus(snapshot.status);
    if (statusClass === 'cancelled') return { kind: 'ignore', reason: 'dispatch_cancelled' };

    const changedBlocks = presentBlocks(blocks);
    if (statusClass === 'beyond_promise') return { kind: 'attention', changedBlocks };

    // Each block replaces the previous one as a whole: a missing `email` or `reference` clears it.
    const wanted: ColumnChanges = {};
    if (blocks.recipient !== undefined) {
        wanted.contactName = blocks.recipient.name;
        wanted.contactPhone = blocks.recipient.phone;
        wanted.contactEmail = blocks.recipient.email ?? null;
    }
    if (blocks.deliveryAddress !== undefined) {
        const usable = isUsableLocation(blocks.deliveryAddress.location);
        wanted.deliveryAddress = blocks.deliveryAddress.line;
        wanted.deliveryReference = blocks.deliveryAddress.reference ?? null;
        wanted.deliveryLatitude = usable ? blocks.deliveryAddress.location!.latitude : null;
        wanted.deliveryLongitude = usable ? blocks.deliveryAddress.location!.longitude : null;
    }
    if (blocks.priority !== undefined) wanted.priority = blocks.priority;

    const columns: ColumnChanges = {};
    const diff: FieldDiff = {};
    for (const key of Object.keys(wanted) as (keyof ColumnChanges)[]) {
        if (wanted[key] !== snapshot[key]) {
            (columns as Record<string, unknown>)[key] = wanted[key];
            diff[key] = { from: snapshot[key], to: wanted[key] };
        }
    }

    const nothingChanged = Object.keys(columns).length === 0;
    return {
        kind: 'update',
        columns,
        diff,
        changedBlocks,
        locationChanged: blocks.deliveryAddress !== undefined,
        // A dispatch that did not really change keeps its place in the proposal.
        removeFromProposal: !nothingChanged && snapshot.routeBatchId !== null && snapshot.status === 'in_planning',
    };
}

export function planCancellation(snapshot: DispatchSnapshot): CancellationPlan {
    const statusClass = classifyDispatchStatus(snapshot.status);
    if (statusClass === 'cancelled') return { kind: 'ignore', reason: 'dispatch_cancelled' };
    if (statusClass === 'beyond_promise') return { kind: 'attention' };
    return { kind: 'cancel', removeFromProposal: snapshot.routeBatchId !== null };
}

export function planShipmentReadiness(snapshot: DispatchSnapshot, ready: boolean): ReadinessPlan {
    const statusClass = classifyDispatchStatus(snapshot.status);
    if (statusClass === 'cancelled') return { kind: 'ignore', reason: 'dispatch_cancelled' };
    if (snapshot.shipmentReady === ready) return { kind: 'noop' };
    if (statusClass === 'beyond_promise') {
        // Any readiness change after the promise needs a coordinator, including delivered/returned.
        return { kind: 'attention' };
    }
    return { kind: 'set', ready, removeFromProposal: !ready && snapshot.routeBatchId !== null };
}

/**
 * Status after an update of an editable dispatch. An address without a zone leaves the plan
 * (`address_review`); a fixed address brings it back (`pending`); leaving the proposed batch also
 * returns `in_planning` to `pending`.
 */
export function statusAfterEdit(input: {
    current: string;
    removedFromProposal: boolean;
    locationChanged: boolean;
    hasZone: boolean;
}): string {
    if (input.locationChanged && !input.hasZone) return 'address_review';
    if (input.locationChanged && input.hasZone && input.current === 'address_review') return 'pending';
    if (input.removedFromProposal && input.current === 'in_planning') return 'pending';
    return input.current;
}
