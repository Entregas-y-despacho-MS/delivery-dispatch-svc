/**
 * `recordVersion` of the messages Despachos publishes to Compras for one pickup (ST-75.1).
 * It is Despachos' own counter, independent of the `recordVersion` Compras sends: the first message
 * is 1 and every scheduling or rescheduling publishes the next one.
 */
export function nextPickupRecordVersion(previousVersions: readonly number[]): number {
    return previousVersions.length === 0 ? 1 : Math.max(...previousVersions) + 1;
}
