import { Type, BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';

export function validateData<T extends object>(dtoClass: Type<T>, data: any): void {
    const dto = plainToInstance(dtoClass, data);
    const errors: ValidationError[] = validateSync(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
        const messages = errors.map(e => Object.values(e.constraints || {})).flat();
        throw new BadRequestException(messages);
    }
}
