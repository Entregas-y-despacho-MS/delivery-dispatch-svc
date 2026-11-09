/** One `inventory.receipt.confirmed` item: identified by `packageId` (a tracked delivery package) or `itemCode` (an RMA/pickup item), never both. */
export interface WarehouseReceiptItemData {
    packageId?:        number | null;
    itemCode?:         string | null;
    acceptedQuantity:  number;
    missingQuantity:   number;
    damagedQuantity:   number;
    detail?:           string | null;
}

/** Payload of `inventory.receipt.confirmed` (ST-240.2, ES-240, ERP-08). */
export interface InventoryReceiptConfirmedData {
    receiptId:         string;
    referenceType:     'rma' | 'purchase_order';
    /** `rmaId` (reference_type = rma) or purchase order id (reference_type = purchase_order); matches `dispatches.source_order_ref`. */
    referenceId:       string;
    result:            'complete' | 'with_differences' | 'rejected';
    /** ISO-8601, when Almacén physically received the goods. */
    receivedAt:        string;
    recordVersion:     number;
    notes?:            string | null;
    /** When present, must match the resolved dispatch's own `tracking_code`; a mismatch is treated as an unresolved reference (orphan). */
    trackingCode?:     string | null;
    items?:            WarehouseReceiptItemData[];
}
