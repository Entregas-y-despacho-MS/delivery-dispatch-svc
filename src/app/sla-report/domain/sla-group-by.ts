/** How the SLA report splits the dispatches it counts (ST-54.2, RF-A07). */
export enum SlaGroupBy {
    ZONE          = 'zone',
    SERVICE_LEVEL = 'service_level',
    DRIVER        = 'driver',
}
