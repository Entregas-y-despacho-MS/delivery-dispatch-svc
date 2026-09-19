import { Expose, Type } from 'class-transformer';

// Symbol keys prevent collisions with other libraries' Reflect metadata.
export const DTO_SELECT_KEY   = Symbol('dto:select');
export const DTO_RELATION_KEY = Symbol('dto:relation');

/**
 * Marks a scalar property (number, string, boolean, date) to be included in
 * the TypeORM SELECT and in the serialized JSON response.
 *
 * @example
 *   class UserDto {
 *     @DtoField() id!: number;
 *     @DtoField() email!: string;
 *   }
 */
export function DtoField(): PropertyDecorator {
    return (target, propertyKey) => {
        const fields: string[] = Reflect.getMetadata(DTO_SELECT_KEY, target) ?? [];
        // Spread into a new array to avoid mutating inherited prototypes.
        Reflect.defineMetadata(DTO_SELECT_KEY, [...fields, propertyKey as string], target);
        Expose()(target, propertyKey);
    };
}

/**
 * Marks a relation property (JOIN) to be included in the TypeORM SELECT/relations
 * and in the serialized JSON response.
 *
 * The lazy `() => RelatedDto` parameter breaks potential circular references.
 *
 * @example
 *   class UserDto {
 *     @DtoField()               id!: number;
 *     @DtoRelation(() => RoleDto) role!: RoleDto;
 *   }
 */
export function DtoRelation(relatedCtor: () => new () => any): PropertyDecorator {
    return (target, propertyKey) => {
        const rels: { key: string; ctor: () => new () => any }[] =
            Reflect.getMetadata(DTO_RELATION_KEY, target) ?? [];

        Reflect.defineMetadata(
            DTO_RELATION_KEY,
            [...rels, { key: propertyKey as string, ctor: relatedCtor }],
            target,
        );

        Expose()(target, propertyKey);
        Type(relatedCtor)(target, propertyKey);
    };
}
