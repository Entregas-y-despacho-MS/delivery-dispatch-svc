export interface ProcurementSupplier {
  supplierId: string;
  name: string;
}

export interface ProcurementContact {
  name: string;
  phone: string;
  email?: string;
}

export interface ProcurementPickupAddress {
  line: string;
  reference?: string;
  location?: { latitude: number; longitude: number };
}

export interface ProcurementPickupWindow {
  startsAt: string;
  endsAt: string;
}

export interface ProcurementPickupProduct {
  productId: string;
  description?: string;
  quantity: number;
}

export interface ProcurementPickupEstimates {
  packages?: number;
  weightKg?: number;
  volumeM3?: number;
}

export type ProcurementTransportCondition = string;

interface ProcurementPickupDataBase {
  purchaseOrderId: string;
  recordVersion: number;
  updatedAt: string;
}

export interface ProcurementPickupRequestedData extends ProcurementPickupDataBase {
  approvedAt?: string;
  supplier: ProcurementSupplier;
  contact?: ProcurementContact;
  pickupAddress?: ProcurementPickupAddress;
  pickupWindow?: ProcurementPickupWindow;
  warehouseId?: string;
  products: ProcurementPickupProduct[];
  estimates?: ProcurementPickupEstimates;
  transportConditions?: ProcurementTransportCondition[];
}

export interface ProcurementPickupUpdatedData extends ProcurementPickupDataBase {
  supplier?: ProcurementSupplier;
  contact?: ProcurementContact;
  pickupAddress?: ProcurementPickupAddress;
  pickupWindow?: ProcurementPickupWindow;
  warehouseId?: string;
  products?: ProcurementPickupProduct[];
  estimates?: ProcurementPickupEstimates;
  transportConditions?: ProcurementTransportCondition[];
}

export interface ProcurementPickupCancelledData extends ProcurementPickupDataBase {
  cancelledAt: string;
  reason?: string;
}

export type ProcurementPickupMessage =
  | { kind: 'requested'; data: ProcurementPickupRequestedData }
  | { kind: 'updated'; data: ProcurementPickupUpdatedData }
  | { kind: 'cancelled'; data: ProcurementPickupCancelledData };
