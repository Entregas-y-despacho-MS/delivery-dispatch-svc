/** Data blocks from the published inventory.shipment.* JSON Schemas (ST-76.1). */
export interface ShipmentPackage {
    packageId: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    grossWeightKg: number;
}

export type ShipmentEvidencePolicy =
    | 'hand_delivery_standard'
    | 'contactless_delivery'
    | 'high_value_control';

export interface ShipmentBlocks {
    warehouseId?: string;
    availableFrom?: string;
    packages?: ShipmentPackage[];
    handlingConditions?: string[];
    evidencePolicy?: ShipmentEvidencePolicy;
    physicallyPacked?: boolean;
    /** Readiness for planning; independent of physicallyPacked. */
    isReady?: boolean;
}

export interface ShipmentState {
    salesOrderId: string;
    lastRecordVersion: number;
    baseReceived: boolean;
    cancelledAt: string | null;
    cancelledVersion: number | null;
    blocks: ShipmentBlocks;
}

interface ShipmentMessageBase {
    salesOrderId: string;
    recordVersion: number;
    updatedAt: string;
}

export interface ShipmentReadyData extends ShipmentMessageBase {
    warehouseId: string;
    packages: ShipmentPackage[];
    availableFrom?: string;
    handlingConditions?: string[];
    evidencePolicy?: ShipmentEvidencePolicy;
    physicallyPacked?: boolean;
}

export interface ShipmentUpdatedData extends ShipmentMessageBase {
    isReady: boolean;
    warehouseId?: string;
    availableFrom?: string;
    packages?: ShipmentPackage[];
    handlingConditions?: string[];
    evidencePolicy?: ShipmentEvidencePolicy;
    physicallyPacked?: boolean;
    reason?: string;
}

export interface ShipmentCancelledData extends ShipmentMessageBase {
    cancelledAt: string;
    reason?: string;
}

export type ShipmentMessage =
    | { kind: 'ready'; data: ShipmentReadyData }
    | { kind: 'updated'; data: ShipmentUpdatedData }
    | { kind: 'cancelled'; data: ShipmentCancelledData };
