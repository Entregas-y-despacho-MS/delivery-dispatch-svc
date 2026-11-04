// dotenv must load first — this script runs outside NestJS.
import 'dotenv/config';

import { AppDataSource } from '../config/data-source.js';
import { User } from '../../modules/auth/users/entities/user.entity.js';
import { Role } from '../../modules/auth/roles/entities/role.entity.js';
import { hashPassword } from '../../shared/utils/crypto.util.js';

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

/**
 * Inserts a development Supervisor user if it does not already exist (ST-59.1, RF-A12), so the
 * Supervisor's portal views and permissions can be tried without creating the account by hand.
 * Idempotent — safe to run multiple times. The default password satisfies the password policy
 * (RF-A25) and is meant for development only: set SEED_SUPERVISOR_PASSWORD or change it elsewhere.
 */
async function seedSupervisorUser(): Promise<void> {
    const username = process.env.SEED_SUPERVISOR_USERNAME  ?? 'supervisor';
    const fullName  = process.env.SEED_SUPERVISOR_FULL_NAME ?? 'Supervisor de Flota';
    const email     = process.env.SEED_SUPERVISOR_EMAIL     ?? 'supervisor@app.com';
    const password  = process.env.SEED_SUPERVISOR_PASSWORD  ?? 'Supervisor1234!';

    const userRepo = AppDataSource.getRepository(User);
    const roleRepo = AppDataSource.getRepository(Role);

    const existing = await userRepo.findOne({ where: { username } });
    if (existing) {
        console.log(`  ${YELLOW}⚠  Supervisor user already exists${RESET} (${username}) — skipping.`);
        return;
    }

    const supervisorRole = await roleRepo.findOneBy({ name: 'supervisor' });
    if (!supervisorRole) throw new Error('Supervisor role not found — seedRoles() must run before seedSupervisorUser().');

    const user = userRepo.create({
        username,
        fullName,
        email,
        passwordHash:      await hashPassword(password),
        passwordChangedAt: new Date(),
        roleId:            supervisorRole.id,
        requiresPwdChange: false,
    });
    await userRepo.save(user);

    console.log(`  ${GREEN}✔  Supervisor user created${RESET} → ${BOLD}${username}${RESET}`);
    console.log(`  ${YELLOW}⚠  Development account — do not seed it in production with the default password.${RESET}`);
}

async function seed(): Promise<void> {
    console.log(`\n${CYAN}${BOLD}▶  Running seed...${RESET}\n`);

    await AppDataSource.initialize();
    console.log(`  ${GREEN}✔  Database connection established${RESET}`);

    try {
        await seedRoles();
        await seedRootUser();
        await seedSupervisorUser();
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
