/** How the SLA report splits the dispatches it counts (ST-54.2, RF-A07). */
export enum SlaGroupBy {
    ZONE          = 'zone',
    SERVICE_LEVEL = 'service_level',
    DRIVER        = 'driver',
    /** By plate of the vehicle of the route. Only the fleet KPIs (ST-61.1) use it; `GET /reports/sla` does not accept it. */
    VEHICLE       = 'vehicle',
}
