/** Which `npm run simulate:*` command exposes a scenario. */
export type SimulatorScript = 'marketplace' | 'inventory' | 'procurement';

/** `entityType` of `dispatch.sync.requested`: it also tells which origin must answer. */
export type SyncEntityType = 'sales_order' | 'shipment';

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
    /** On purpose it does not meet its schema; `contracts:check` (ST-73.4) must expect the failure. */
    expectInvalid?: boolean;
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
    expectInvalid: boolean;
    /** Order the message belongs to (`salesOrderId` or `purchaseOrderId`, already suffixed with the run). */
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
}
