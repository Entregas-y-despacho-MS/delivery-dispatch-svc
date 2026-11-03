export interface RmaContact {
    name: string;
    phone: string;
    email?: string;
}

export interface RmaPickupAddress {
    line: string;
    reference?: string;
    location?: { latitude: number; longitude: number };
}

export interface RmaPackage {
    packageId: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    grossWeightKg: number;
}

/** `inventory.return.requested` — data (contracts/messages/schemas/inventory.return.requested.schema.json). */
export interface RmaPickupRequestedData {
    rmaId: string;
    salesOrderId?: string;
    recordVersion: number;
    updatedAt: string;
    approvedAt: string;
    warehouseId: string;
    contact: RmaContact;
    pickupAddress: RmaPickupAddress;
    returnReason: string;
    packages?: RmaPackage[];
    preferredPickupDate?: string;
}
