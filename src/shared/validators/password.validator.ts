import { IsStrongPasswordOptions } from 'class-validator';

// RF-A25, Escenario 1 — mínimo 8, 1 mayúscula, 1 minúscula, 1 número, 1 carácter especial.
// Piso estructural fijo a nivel DTO; UsersService valida además el mínimo configurable en
// runtime (settings.password_min_length) — ver .claude/rules/settings.md.
export const STRONG_PASSWORD_OPTIONS: IsStrongPasswordOptions = {
    minLength:    8,
    minLowercase: 1,
    minUppercase: 1,
    minNumbers:   1,
    minSymbols:   1,
};

export const STRONG_PASSWORD_MESSAGE =
    'Password must be at least 8 characters and include at least 1 uppercase letter, ' +
    '1 lowercase letter, 1 number, and 1 special character.';
