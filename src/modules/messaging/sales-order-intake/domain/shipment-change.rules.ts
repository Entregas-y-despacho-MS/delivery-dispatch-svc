import type { EvidencePolicy, ShipmentPackage } from './consolidated-order.types.js';
import { classifyDispatchStatus, statusAfterEdit } from './dispatch-change.rules.js';

/**
 * Rules for a change of the packages of Almacén that arrives for an order that already is a
 * dispatch (ST-72.5, Escenario 5 of ES-72). Pure: they decide from the dispatch as it is now.
 *
 * - Nothing to do when the change does not differ from what the dispatch already has: a resent
 *   `ready` never alters the planning.
 * - `pending`, `address_review`, `in_planning`: the change is applied; a dispatch of a proposed
 *   batch leaves it (the capacity it was planned with is no longer true).
 * - `scheduled` and anything after it: the dispatch is not modified; the coordinator decides.
 * - `cancelled`: nothing to do.
 *
 * A different `warehouseId` (the code of the origin warehouse) follows the same matrix as the
 * packages and always takes a planned dispatch out of its batch: a batch leaves from one
 * warehouse, so the dispatch no longer belongs to the one it was proposed in. The zone does not
 * change (it comes from the destination). `availableFrom` has no column in `dispatches`: it stays
 * in the payload of `pending_shipments` and is not applied here.
 */

/** Scale of `dispatch_packages` columns: `length/width/height` NUMERIC(8,2), weight NUMERIC(10,3). */
const DIMENSION_DECIMALS = 2;
const WEIGHT_DECIMALS = 3;

/** One row of `dispatch_packages` as the rules read and write it. */
export interface DispatchPackageSnapshot {
    /** `external_package_id`: the `packageId` Almacén assigned. */
    packageId: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    grossWeightKg: number;
    handlingConditions: string[];
}

/** The dispatch as the package rules need to read it. */
export interface ShipmentDispatchSnapshot {
    dispatchId: number;
    status: string;
    routeBatchId: number | null;
    evidencePolicy: string;
    packageReadyAt: Date | null;
    packages: DispatchPackageSnapshot[];
    /** `warehouses.code` of the origin warehouse of the dispatch, or `null` if it has none. */
    originWarehouseCode: string | null;
}

/** The blocks of `ready` / `updated` of Almacén that can change a dispatch. Absent = no change. */
export interface ShipmentChangeBlocks {
    packages?: ShipmentPackage[];
    handlingConditions?: string[];
    evidencePolicy?: EvidencePolicy;
    physicallyPacked?: boolean;
    /** Code of the origin warehouse (`warehouses.code`), not its numeric id. */
    warehouseId?: string;
}

export type ShipmentBlockName =
    | 'packages'
    | 'handlingConditions'
    | 'evidencePolicy'
    | 'physicallyPacked'
    | 'warehouseId';

export type ShipmentDiff = Partial<Record<ShipmentBlockName, { from: unknown; to: unknown }>>;

export type ShipmentChangePlan =
    | { kind: 'ignore'; reason: 'dispatch_cancelled' }
    /** The change does not differ from the dispatch: nothing is written and nothing is emitted. */
    | { kind: 'noop' }
    /** Past the promise: the dispatch is left untouched and the coordinator is told what changed. */
    | { kind: 'attention'; changedBlocks: ShipmentBlockName[]; diff: ShipmentDiff }
    | {
          kind: 'update';
          /** The complete new list, only when the packages or their conditions changed. */
          packages: DispatchPackageSnapshot[] | null;
          /** The new policy, only when it changed. */
          evidencePolicy: string | null;
          /** `physicallyPacked: true` on a dispatch that did not have `package_ready_at` yet. */
          fillPackageReadyAt: boolean;
          /** The new origin warehouse code, only when it changed. */
          warehouseCode: string | null;
          changedBlocks: ShipmentBlockName[];
          diff: ShipmentDiff;
          removeFromProposal: boolean;
          statusAfter: string;
      };

function roundTo(value: number, decimals: number): number {
    return Number(value.toFixed(decimals));
}

/** Conditions are a set: order and repeats do not matter. */
export function normalizeConditions(conditions: readonly string[]): string[] {
    return [...new Set(conditions)].sort();
}

/**
 * The package as the database stores it (numeric scale included), so a value Almacén sends with
 * more decimals than the column keeps is not mistaken for a change on every resend.
 */
export function toPackageSnapshot(item: ShipmentPackage, handlingConditions: readonly string[]): DispatchPackageSnapshot {
    return {
        packageId: item.packageId,
        lengthCm: roundTo(item.lengthCm, DIMENSION_DECIMALS),
        widthCm: roundTo(item.widthCm, DIMENSION_DECIMALS),
        heightCm: roundTo(item.heightCm, DIMENSION_DECIMALS),
        grossWeightKg: roundTo(item.grossWeightKg, WEIGHT_DECIMALS),
        handlingConditions: normalizeConditions(handlingConditions),
    };
}

/** Packages sorted by id and with their keys in a fixed order, so two lists compare equal as text. */
function canonicalPackages(packages: readonly DispatchPackageSnapshot[]): DispatchPackageSnapshot[] {
    return packages
        .map((item) => ({
            packageId: item.packageId,
            lengthCm: item.lengthCm,
            widthCm: item.widthCm,
            heightCm: item.heightCm,
            grossWeightKg: item.grossWeightKg,
            handlingConditions: normalizeConditions(item.handlingConditions),
        }))
        .sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0));
}

/** Only what describes the physical package: id, measures and weight (not its conditions). */
function physicalKey(packages: readonly DispatchPackageSnapshot[]): string {
    return JSON.stringify(
        canonicalPackages(packages).map((item) => [item.packageId, item.lengthCm, item.widthCm, item.heightCm, item.grossWeightKg]),
    );
}

function samePackages(a: readonly DispatchPackageSnapshot[], b: readonly DispatchPackageSnapshot[]): boolean {
    return JSON.stringify(canonicalPackages(a)) === JSON.stringify(canonicalPackages(b));
}

/** The conditions the dispatch has now: the ones its packages share (union, as the generator wrote them). */
export function currentConditions(packages: readonly DispatchPackageSnapshot[]): string[] {
    return normalizeConditions(packages.flatMap((item) => item.handlingConditions));
}

/**
 * What Almacén's change leaves the dispatch with, or `null` when the packages are not touched.
 * A block that is absent keeps what the dispatch has; `packages` replaces the whole list and, if
 * the same message does not carry `handlingConditions`, keeps the conditions the dispatch had.
 * If the same `packageId` comes twice, the last one wins (the table is unique by package).
 */
function nextPackages(
    snapshot: ShipmentDispatchSnapshot,
    blocks: ShipmentChangeBlocks,
): DispatchPackageSnapshot[] | null {
    const sentPackages = blocks.packages && blocks.packages.length > 0 ? blocks.packages : undefined;
    if (sentPackages === undefined && blocks.handlingConditions === undefined) return null;

    const conditions = blocks.handlingConditions ?? currentConditions(snapshot.packages);

    if (sentPackages === undefined) {
        return snapshot.packages.map((item) => ({ ...item, handlingConditions: normalizeConditions(conditions) }));
    }

    const byId = new Map<string, DispatchPackageSnapshot>();
    for (const item of sentPackages) byId.set(item.packageId, toPackageSnapshot(item, conditions));
    return [...byId.values()];
}

export function planShipmentChange(snapshot: ShipmentDispatchSnapshot, blocks: ShipmentChangeBlocks): ShipmentChangePlan {
    const statusClass = classifyDispatchStatus(snapshot.status);
    if (statusClass === 'cancelled') return { kind: 'ignore', reason: 'dispatch_cancelled' };

    const diff: ShipmentDiff = {};
    const changedBlocks: ShipmentBlockName[] = [];

    const wanted = nextPackages(snapshot, blocks);
    let packages: DispatchPackageSnapshot[] | null = null;
    if (wanted !== null && !samePackages(wanted, snapshot.packages)) {
        packages = wanted;
        if (physicalKey(wanted) !== physicalKey(snapshot.packages)) {
            changedBlocks.push('packages');
            diff.packages = { from: canonicalPackages(snapshot.packages), to: canonicalPackages(wanted) };
        }
        if (JSON.stringify(currentConditions(wanted)) !== JSON.stringify(currentConditions(snapshot.packages))) {
            changedBlocks.push('handlingConditions');
            diff.handlingConditions = { from: currentConditions(snapshot.packages), to: currentConditions(wanted) };
        }
    }

    let evidencePolicy: string | null = null;
    if (blocks.evidencePolicy !== undefined && blocks.evidencePolicy !== snapshot.evidencePolicy) {
        evidencePolicy = blocks.evidencePolicy;
        changedBlocks.push('evidencePolicy');
        diff.evidencePolicy = { from: snapshot.evidencePolicy, to: blocks.evidencePolicy };
    }

    // `true` fills the moment once; `false` never clears it (a packed shipment is not unpacked).
    const fillPackageReadyAt = blocks.physicallyPacked === true && snapshot.packageReadyAt === null;
    if (fillPackageReadyAt) {
        changedBlocks.push('physicallyPacked');
        diff.physicallyPacked = { from: null, to: 'now' };
    }

    // A different origin warehouse. Both sides are `warehouses.code`.
    let warehouseCode: string | null = null;
    if (blocks.warehouseId !== undefined && blocks.warehouseId !== snapshot.originWarehouseCode) {
        warehouseCode = blocks.warehouseId;
        changedBlocks.push('warehouseId');
        diff.warehouseId = { from: snapshot.originWarehouseCode, to: blocks.warehouseId };
    }

    if (changedBlocks.length === 0) return { kind: 'noop' };

    if (statusClass === 'beyond_promise') return { kind: 'attention', changedBlocks, diff };

    // Only a change that touches the capacity (packages, conditions) or the origin of a planned
    // dispatch takes it out of its batch; the evidence policy and the packing moment do not.
    const touchesPlanning = packages !== null || warehouseCode !== null;
    const removeFromProposal = touchesPlanning && snapshot.status === 'in_planning' && snapshot.routeBatchId !== null;

    return {
        kind: 'update',
        packages,
        evidencePolicy,
        fillPackageReadyAt,
        warehouseCode,
        changedBlocks,
        diff,
        removeFromProposal,
        statusAfter: statusAfterEdit({
            current: snapshot.status,
            removedFromProposal: removeFromProposal,
            locationChanged: false,
            hasZone: true,
        }),
    };
}
