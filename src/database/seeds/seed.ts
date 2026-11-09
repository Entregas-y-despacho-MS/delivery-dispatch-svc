// dotenv must load first — this script runs outside NestJS.
import 'dotenv/config';

import { AppDataSource } from '../config/data-source.js';
import { User } from '../../modules/auth/users/entities/user.entity.js';
import { Role } from '../../modules/auth/roles/entities/role.entity.js';
import { hashPassword } from '../../shared/utils/crypto.util.js';
import { EnvironmentEnum } from '../../shared/enums/environment.enum.js';

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

// Must match RoleEnum (shared/enums/role.enum.ts) and schema/auth/roles/data.sql exactly.
const ROLE_NAMES = ['root', 'admin', 'coordinator', 'supervisor', 'driver'] as const;

/**
 * Inserts the 5 roles if they don't already exist.
 * Idempotent — safe to run multiple times.
 */
async function seedRoles(): Promise<void> {
    const repo = AppDataSource.getRepository(Role);

    for (const name of ROLE_NAMES) {
        const existing = await repo.findOne({ where: { name } });
        if (existing) continue;

        const role = repo.create({ name });
        await repo.save(role);
        console.log(`  ${GREEN}✔  Role created${RESET} → ${name}`);
    }
}

/**
 * Inserts the root user if it does not already exist.
 * Idempotent — safe to run multiple times.
 */
async function seedRootUser(): Promise<void> {
    const username = process.env.SEED_ROOT_USERNAME  ?? 'root';
    const fullName  = process.env.SEED_ROOT_FULL_NAME ?? 'Root';
    const email     = process.env.SEED_ROOT_EMAIL     ?? 'root@app.com';
    const password  = process.env.SEED_ROOT_PASSWORD  ?? 'Root1234!';

    const userRepo = AppDataSource.getRepository(User);
    const roleRepo = AppDataSource.getRepository(Role);

    const existing = await userRepo.findOne({ where: { username } });
    if (existing) {
        console.log(`  ${YELLOW}⚠  Root user already exists${RESET} (${username}) — skipping.`);
        return;
    }

    const rootRole = await roleRepo.findOneBy({ name: 'root' });
    if (!rootRole) throw new Error('Root role not found — seedRoles() must run before seedRootUser().');

    const hashed = await hashPassword(password);

    const user = userRepo.create({
        username,
        fullName,
        email,
        passwordHash:      hashed,
        passwordChangedAt: new Date(),
        roleId:            rootRole.id,
        requiresPwdChange: false,
    });
    await userRepo.save(user);

    console.log(`  ${GREEN}✔  Root user created${RESET} → ${BOLD}${username}${RESET}`);
    console.log(`  ${YELLOW}⚠  Change the root password in production.${RESET}`);
}

interface DemoUserSpec {
    label: string;
    role: string;
    envPrefix: string;
    defaultUsername: string;
    defaultFullName: string;
    defaultEmail: string;
    defaultPassword: string;
}

const DEMO_USERS: readonly DemoUserSpec[] = [
    {
        label: 'Supervisor', role: 'supervisor', envPrefix: 'SEED_SUPERVISOR',
        defaultUsername: 'supervisor', defaultFullName: 'Supervisor de Flota',
        defaultEmail: 'supervisor@app.com', defaultPassword: 'Supervisor1234!',
    },
    {
        label: 'Coordinator', role: 'coordinator', envPrefix: 'SEED_COORDINATOR',
        defaultUsername: 'coordinator', defaultFullName: 'Coordinador de Despacho',
        defaultEmail: 'coordinator@app.com', defaultPassword: 'Coordinator1234!',
    },
    {
        label: 'Driver', role: 'driver', envPrefix: 'SEED_DRIVER',
        defaultUsername: 'driver', defaultFullName: 'Repartidor Demo',
        defaultEmail: 'driver@app.com', defaultPassword: 'Driver1234!',
    },
] as const;

/**
 * True unless NODE_ENV=production without SEED_DEMO_USERS=true — the demo accounts below (the
 * Supervisor one and its coordinator/driver siblings) use a password hardcoded in this file, so a
 * real deployment must opt in explicitly instead of getting them by default. The Dockerfile's CMD
 * runs this seed on every boot, production included, so this check is what keeps them out of it.
 */
function demoUsersEnabled(): boolean {
    return process.env.NODE_ENV !== EnvironmentEnum.PRODUCTION || process.env.SEED_DEMO_USERS === 'true';
}

/**
 * Inserts one demo user (Supervisor/Coordinator/Driver) if it does not already exist, so each
 * role's views can be tried right after a fresh deploy without creating the account by hand.
 * Idempotent — safe to run multiple times. Skipped entirely in production unless SEED_DEMO_USERS=true
 * (see demoUsersEnabled()) — the password below is a known default, never meant to reach a real environment.
 */
async function seedDemoUser(spec: DemoUserSpec): Promise<void> {
    const username = process.env[`${spec.envPrefix}_USERNAME`]  ?? spec.defaultUsername;
    const fullName  = process.env[`${spec.envPrefix}_FULL_NAME`] ?? spec.defaultFullName;
    const email     = process.env[`${spec.envPrefix}_EMAIL`]     ?? spec.defaultEmail;
    const password  = process.env[`${spec.envPrefix}_PASSWORD`]  ?? spec.defaultPassword;

    const userRepo = AppDataSource.getRepository(User);
    const roleRepo = AppDataSource.getRepository(Role);

    const existing = await userRepo.findOne({ where: { username } });
    if (existing) {
        console.log(`  ${YELLOW}⚠  ${spec.label} user already exists${RESET} (${username}) — skipping.`);
        return;
    }

    const role = await roleRepo.findOneBy({ name: spec.role });
    if (!role) throw new Error(`${spec.role} role not found — seedRoles() must run before seedDemoUser(${spec.role}).`);

    const user = userRepo.create({
        username,
        fullName,
        email,
        passwordHash:      await hashPassword(password),
        passwordChangedAt: new Date(),
        roleId:            role.id,
        requiresPwdChange: false,
    });
    await userRepo.save(user);

    console.log(`  ${GREEN}✔  ${spec.label} user created${RESET} → ${BOLD}${username}${RESET}`);
    console.log(`  ${YELLOW}⚠  Development account — do not seed it in production with the default password.${RESET}`);
}

async function seed(): Promise<void> {
    console.log(`\n${CYAN}${BOLD}▶  Running seed...${RESET}\n`);

    await AppDataSource.initialize();
    console.log(`  ${GREEN}✔  Database connection established${RESET}`);

    try {
        await seedRoles();
        await seedRootUser();
        if (demoUsersEnabled()) {
            for (const spec of DEMO_USERS) await seedDemoUser(spec);
        } else {
            console.log(`  ${YELLOW}⚠  Skipping demo users${RESET} (NODE_ENV=production without SEED_DEMO_USERS=true).`);
        }
        // Add more seeders here in dependency order.

        console.log(`\n${GREEN}${BOLD}✔  Seed completed.${RESET}\n`);
    } catch (error) {
        console.error(`\n${RED}${BOLD}✘  Seed failed:${RESET}`, error);
        process.exit(1);
    } finally {
        await AppDataSource.destroy();
    }
}

seed();
