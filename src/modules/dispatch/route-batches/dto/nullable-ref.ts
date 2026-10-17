import { getSchemaPath } from '@nestjs/swagger';
import type { Type } from '@nestjs/common';

/** Schema of a property that is either `model` or null; `type: () => model, nullable: true` is published as a bare object. */
export const nullableRef = (model: Type<unknown>) => ({ nullable: true, allOf: [{ $ref: getSchemaPath(model) }] });
