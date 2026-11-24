import { isStrongPassword } from 'class-validator';
import type { Repository } from 'typeorm';

import { User } from '../../modules/auth/users/entities/user.entity.js';
import { Role } from '../../modules/auth/roles/entities/role.entity.js';
import { hashPassword } from '../../shared/utils/crypto.util.js';
import { EnvironmentEnum } from '../../shared/enums/environment.enum.js';
import { STRONG_PASSWORD_OPTIONS } from '../../shared/validators/password.validator.js';

/**
 * Root bootstrap (ST-310.2, RF-A25, ES-310 Escenario 4).
 *
 * Lives apart from seed.ts so it can be tested: seed.ts runs the whole seed as soon as it is imported.
 *
 * Rules:
 * - There is NO default password, in any environment. `SEED_ROOT_PASSWORD` is required, and only when the
 *   root account has to be created: an existing root is skipped without reading the secret (the Dockerfile
 *   runs the seed on every boot, so asking for it every time would stop a healthy deployment from starting
 *   the day the variable is removed).
 * - An existing root is never updated, so a password the operator already rotated is never reset.
 * - The account is created with `requiresPwdChange = true`: until the password is changed, PasswordChangeGuard
 *   only lets it reach change-password and logout.
 * - The password is never printed, returned or put in an error message.
 */

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

/** Raised before anything is written when the root secret is missing or does not meet the password policy. */
export class RootSeedPasswordError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RootSeedPasswordError';
    }
}

export type RootSeedEnv = Record<string, string | undefined>;
type Logger = (message: string) => void;

/**
 * Reads `SEED_ROOT_PASSWORD` and checks it against the structural password policy (RF-A25: 8+ characters,
 * upper, lower, number, symbol). Throws `RootSeedPasswordError` with a message that never contains the value.
 */
export function requireRootPassword(env: RootSeedEnv): string {
    const password = env.SEED_ROOT_PASSWORD;
    const inProduction = env.NODE_ENV === EnvironmentEnum.PRODUCTION;

    if (password === undefined || password === '') {
        throw new RootSeedPasswordError(
            `SEED_ROOT_PASSWORD is required to create the root account${inProduction ? ' in production' : ''}. ` +
            'Set it to a strong secret and run the seed again (there is no default password).',
        );
    }
    // A value copied from a .env written on Windows often ends in a space or CR/LF, which isStrongPassword would
    // count as a "symbol"; the account would then need that invisible character to log in. Reject it, never trim.
    if (password !== password.trim()) {
        throw new RootSeedPasswordError(
            'SEED_ROOT_PASSWORD must not start or end with whitespace (check for a trailing space or line break).',
        );
    }
    if (!isStrongPassword(password, STRONG_PASSWORD_OPTIONS)) {
        throw new RootSeedPasswordError(
            'SEED_ROOT_PASSWORD does not meet the password policy: at least 8 characters with an uppercase letter, ' +
            'a lowercase letter, a number and a special character.',
        );
    }
    return password;
}

/**
 * Text safe to print when the seed fails. Never the error object itself: a TypeORM `QueryFailedError` carries
 * `query` and `parameters`, and a failed INSERT of the root would put its `password_hash` in the container logs
 * (the Dockerfile runs the seed on every boot).
 */
export function describeSeedError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return 'Unknown error';
}

/**
 * Creates the root user unless one with that username already exists. Idempotent: a second run changes nothing.
 * `log` receives only non-sensitive text.
 */
export async function seedRootUser(
    userRepo: Pick<Repository<User>, 'findOne' | 'create' | 'save'>,
    roleRepo: Pick<Repository<Role>, 'findOneBy'>,
    env: RootSeedEnv = process.env,
    log: Logger = console.log,
): Promise<void> {
    const username = env.SEED_ROOT_USERNAME  ?? 'root';
    const fullName = env.SEED_ROOT_FULL_NAME ?? 'Root';
    const email    = env.SEED_ROOT_EMAIL     ?? 'root@app.com';

    const existing = await userRepo.findOne({ where: { username } });
    if (existing) {
        log(`  ${YELLOW}⚠  Root user already exists${RESET} (${username}) — skipping, its password is left untouched.`);
        return;
    }

    // Before any write: a missing or weak secret must stop the seed, not create a predictable account.
    const password = requireRootPassword(env);

    const rootRole = await roleRepo.findOneBy({ name: 'root' });
    if (!rootRole) throw new Error('Root role not found — seedRoles() must run before seedRootUser().');

    const user = userRepo.create({
        username,
        fullName,
        email,
        passwordHash:      await hashPassword(password),
        passwordChangedAt: new Date(),
        roleId:            rootRole.id,
        requiresPwdChange: true,
    });
    await userRepo.save(user);

    log(`  ${GREEN}✔  Root user created${RESET} → ${BOLD}${username}${RESET}`);
    log(`  ${YELLOW}⚠  The root account must change its password at first login.${RESET}`);
}
