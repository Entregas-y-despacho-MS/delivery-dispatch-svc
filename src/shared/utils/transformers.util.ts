import { BadRequestException } from '@nestjs/common';

export function transformToBoolean(value: any, name: string): boolean | null {
    if (value === undefined || value === null || value === '') return null;
    if (value === 'true')  return true;
    if (value === 'false') return false;
    throw new BadRequestException({
        message: `${name} must be a boolean value (true or false)`,
    });
}
