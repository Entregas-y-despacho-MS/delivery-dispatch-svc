import { ValidateIf } from 'class-validator';

/**
 * For PUT/PATCH DTOs on NOT NULL columns: the field may be omitted, but if it is sent it must be a
 * valid value — `null` is validated (and rejected) like any other value.
 *
 * Do not use `@IsOptional()` for these: it skips validation for `null` as well as `undefined`, so
 * `{ "name": null }` passes the DTO and then hits the NOT NULL column (500 instead of 400).
 * `@IsOptional()` is still right for columns that really are nullable.
 */
export const OptionalNotNull = () => ValidateIf((_, value) => value !== undefined);
