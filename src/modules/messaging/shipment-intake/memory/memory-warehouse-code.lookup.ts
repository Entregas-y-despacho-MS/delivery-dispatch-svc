import { Injectable } from '@nestjs/common';
import { WarehouseCodeLookup } from '../ports/warehouse-code.lookup.js';

@Injectable()
export class MemoryWarehouseCodeLookup extends WarehouseCodeLookup {
    constructor(private readonly codes: Set<string> = new Set()) {
        super();
    }

    async exists(code: string): Promise<boolean> {
        return this.codes.has(code);
    }

    add(code: string): void {
        this.codes.add(code);
    }
}
