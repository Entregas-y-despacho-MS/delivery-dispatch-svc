/** Which `npm run simulate:*` command exposes a scenario. */
export type SimulatorScript = 'marketplace' | 'inventory' | 'procurement' | 'demo-returns' | 'crm';

/** `entityType` of `dispatch.sync.requested`: it also tells which origin must answer. */
export type SyncEntityType = 'sales_order' | 'shipment';

/**
 * What Despachos must answer to a CRM complaint (ST-298.4): `received` / `rejected` are the acknowledgements
 * `dispatch.delivery_complaint.*` correlated by `correlationMessageId`; `ignored` is a stale or repeated
 * version, which gets no acknowledgement at all.
 */
export interface ExpectedAck {
    outcome: 'received' | 'rejected' | 'ignored';
    /** Only with `rejected`: the stable `rejectionCode` of the acknowledgement. */
    rejectionCode?: string;
    /** Only with `schema_invalid`: JSON Pointer of the first field that failed. */
    field?: string;
}

/** One message of a scenario, as stored in the fixture (complete envelope, fixed ids and dates). */
export interface ScenarioStep {
    /** What the step represents; the scripts print it. */
    label: string;
    /** The envelope exactly as the ERP would publish it. */
    message: Record<string, unknown>;
    /** Times the same message (same `messageId`) is published. Defaults to 1. */
    repeat?: number;
    /** The message is withheld until `dispatch.sync.requested` of this `entityType` asks for the order. */
    respondsTo?: SyncEntityType;
    /**
     * The message waits for the configurable pause (`--pause`) before it is published, so a person can move the
     * dispatch the previous steps created (e.g. to `picked_up_in_transit`) before the warehouse confirms it.
     */
    pauseBefore?: boolean;
    /** On purpose it does not meet its schema; `contracts:check` (ST-73.4) must expect the failure. */
    expectInvalid?: boolean;
    /** CRM scenarios: the acknowledgement the simulator waits for after publishing the step. */
    expectAck?: ExpectedAck;
    /**
     * CRM scenarios: the step claims a delivery that must exist. The fixture carries a placeholder reference and the
     * run replaces it with the real `delivered` dispatch the person passes (`--dispatch-id` / `--tracking-code`).
     */
    realDispatch?: boolean;
}

/** A versioned fixture file: `test/simulator/fixtures/<scenario>.json`. */
export interface ScenarioFixture {
    /** Kebab-case name; equals the file name. */
    scenario: string;
    script: SimulatorScript;
    description: string;
    /** What must be observed after running it (the README repeats it). */
    expected: string;
    /**
     * Reference instant of the fixture's dates. The builder shifts every date-time by `now - anchor`, so
     * relative offsets are kept and a pickup window never falls in the past (the consumer rejects that).
     */
    anchor: string;
    steps: ScenarioStep[];
}

export interface BuiltStep {
    label: string;
    /** Topic to publish to: the envelope `type`. */
    topic: string;
    envelope: Record<string, unknown>;
    repeat: number;
    respondsTo?: SyncEntityType;
    pauseBefore: boolean;
    expectInvalid: boolean;
    expectAck?: ExpectedAck;
    realDispatch: boolean;
    /** Order the message belongs to (`crmCaseId`, `rmaId`, `salesOrderId` or `purchaseOrderId`, already suffixed with the run). */
    orderId: string;
}

export interface BuiltScenario {
    scenario: string;
    script: SimulatorScript;
    description: string;
    expected: string;
    runId: string;
    steps: BuiltStep[];
}

export interface BuildOptions {
    /** Suffix that makes ids unique per run. A random one by default. */
    runId?: string;
    /** Keep the fixture's ids and dates untouched. */
    asIs?: boolean;
    /** "Now" for the date shift. Defaults to the current instant. */
    now?: Date;
    /** The dispatch every `realDispatch` step claims; whichever field is missing is removed from the message. */
    dispatch?: { dispatchId?: number; trackingCode?: string };
}
