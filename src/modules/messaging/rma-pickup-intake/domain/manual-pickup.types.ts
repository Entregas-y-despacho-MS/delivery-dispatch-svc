/** A customer pickup the coordinator registers by hand (ST-81.2): the data `PickupOrderService.createManual` writes. */
export interface ManualPickupInput {
    /** `warehouses.code` of the warehouse that will receive the goods. */
    warehouseCode: string;
    contactName: string;
    contactPhone: string;
    contactEmail?: string | null;
    address: string;
    reference?: string | null;
    latitude: number;
    longitude: number;
    /** Bolivia calendar day (`YYYY-MM-DD`) the customer prefers the pickup on. */
    preferredPickupDate: string;
    packageContents: string;
    estimatedBoxes?: number | null;
    /** Free text, as the RMA brings it (`dispatches.return_reason`). */
    returnReason: string;
    /** Optional RMA the order refers to; kept only in the audit event, never as `source_order_ref`. */
    rmaId?: string | null;
}

export interface ManualPickupCreated {
    dispatchId: number;
    /** `address_review` when the marked point does not fall inside any known delivery zone (D-19, like a delivery). */
    status: 'pickup_scheduled' | 'address_review';
    trackingCode: string;
    sourceOrderRef: string;
}
