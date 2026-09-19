import { DTO_SELECT_KEY, DTO_RELATION_KEY } from './decorators.js';

export interface FindOptions {
    select:    any;
    relations: any;
}

// Path 1: DTO uses @DtoField / @DtoRelation → read Reflect metadata recursively.
function buildFromMetadata<T>(ctor: new () => T): FindOptions {
    const scalarKeys: string[] = Reflect.getMetadata(DTO_SELECT_KEY, ctor.prototype) ?? [];
    const relationMeta: { key: string; ctor: () => new () => any }[] =
        Reflect.getMetadata(DTO_RELATION_KEY, ctor.prototype) ?? [];

    const select: Record<string, any>    = {};
    const relations: Record<string, any> = {};

    scalarKeys.forEach((key) => (select[key] = true));

    relationMeta.forEach(({ key, ctor: relCtor }) => {
        const nested = buildFindOptions(relCtor());
        if (nested.select) select[key] = nested.select;
        relations[key] = nested.relations ?? true;
    });

    return {
        select:    Object.keys(select).length    ? select    : undefined,
        relations: Object.keys(relations).length ? relations : undefined,
    };
}

// Path 2: legacy DTO with initialized properties (e.g. id = 0; role = new RoleDto()).
function isPrimitive(v: any): boolean {
    return v === null || v === undefined || (typeof v !== 'object' && typeof v !== 'function');
}

function toSelectOptions(obj: any, seen = new WeakSet()): any {
    if (isPrimitive(obj)) return true;
    if (seen.has(obj))    return true;
    seen.add(obj);
    if (Array.isArray(obj)) return obj.length === 0 ? true : toSelectOptions(obj[0], seen);
    const res: any = {};
    for (const key of Object.keys(obj)) {
        res[key] = isPrimitive(obj[key]) ? true : toSelectOptions(obj[key], seen);
    }
    return res;
}

function toRelationOptions(obj: any, seen = new WeakSet()): any {
    if (isPrimitive(obj)) return false;
    if (seen.has(obj))    return true;
    seen.add(obj);
    if (Array.isArray(obj)) return obj.length === 0 ? false : toRelationOptions(obj[0], seen);
    const res: any = {};
    let hasRelation = false;
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (isPrimitive(val)) continue;
        const child = toRelationOptions(val, seen);
        res[key] = child === false ? true : child;
        hasRelation = true;
    }
    return hasRelation ? res : false;
}

/**
 * Derives { select, relations } for TypeORM automatically from a DTO class.
 * Single source of truth: adding a field to the DTO updates all queries.
 */
export function buildFindOptions<T>(ctor: new () => T): FindOptions {
    const hasDecoratorMeta =
        Reflect.hasMetadata(DTO_SELECT_KEY, ctor.prototype) ||
        Reflect.hasMetadata(DTO_RELATION_KEY, ctor.prototype);

    if (hasDecoratorMeta) return buildFromMetadata(ctor);

    const obj = new ctor();
    return {
        select:    toSelectOptions(obj),
        relations: toRelationOptions(obj),
    };
}
