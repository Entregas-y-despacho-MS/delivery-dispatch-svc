// RF-A25 (ST-310.1) — the password policy is configurable: the administrator sets the minimum length and which
// character classes are required (settings password_min_length, password_require_*). Those values are applied at
// runtime by UsersService.validatePasswordPolicy in every path that sets a password (create, admin update, change,
// reset). The DTOs keep only the structural floor below, so a policy that turns a requirement off is not blocked
// earlier by a fixed rule.

/** The minimum length is never below this, whatever the settings say (the settings validator enforces it too). */
export const PASSWORD_MIN_LENGTH_FLOOR = 8;

export const PASSWORD_TOO_SHORT_FLOOR_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH_FLOOR} characters.`;

export interface PasswordPolicy {
    minLength:        number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumber:    boolean;
    requireSymbol:    boolean;
}

/** The policy of a clean install: the 4 options on and the minimum at the floor. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
    minLength:        PASSWORD_MIN_LENGTH_FLOOR,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber:    true,
    requireSymbol:    true,
};

// Same symbol set `@IsStrongPassword` used before the policy became configurable.
const SYMBOL = /[-#!$@£%^&*()_+|~=`{}[\]:";'<>?,./\\ ]/;
const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;
const NUMBER = /[0-9]/;

/** The required character classes the password lacks, as short phrases ("1 uppercase letter"). Empty = it complies. */
export function missingPasswordRequirements(password: string, policy: PasswordPolicy): string[] {
    const missing: string[] = [];
    if (policy.requireUppercase && !UPPERCASE.test(password)) missing.push('1 uppercase letter');
    if (policy.requireLowercase && !LOWERCASE.test(password)) missing.push('1 lowercase letter');
    if (policy.requireNumber && !NUMBER.test(password)) missing.push('1 number');
    if (policy.requireSymbol && !SYMBOL.test(password)) missing.push('1 special character');
    return missing;
}
