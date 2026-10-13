import type { MutationOptions } from '../../../../shared/dto/options.dto.js';

/** Resolves the external warehouse code against the local catalog before writing an Inventory message. */
export abstract class WarehouseCodeLookup {
    abstract exists(code: string, options?: MutationOptions): Promise<boolean>;
}
