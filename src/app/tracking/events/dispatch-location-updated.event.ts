export const DISPATCH_LOCATION_UPDATED_EVENT = 'dispatch.location.updated';

export interface DispatchLocationUpdatedEvent {
    dispatchId: number;
    latitude: number;
    longitude: number;
    recordedAt: string;
}
