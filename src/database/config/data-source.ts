// dotenv must load first — TypeORM CLI runs without NestJS, so there is no DI or AppConfig.
import 'dotenv/config';

import { DataSource } from 'typeorm';

// Used by the TypeORM CLI (via tsx, running from src/) and by seed.ts — which also runs
// compiled, via plain `node`, from dist/ inside Docker. Pick the matching glob for each case.
const isCompiled = import.meta.url.includes('/dist/');

// Keep connection settings in sync with DatabaseConfig.
export const AppDataSource = new DataSource({
    type:     process.env.DB_TYPE as any,
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    entities:   [isCompiled ? 'dist/**/*.entity.js' : 'src/**/*.entity.ts'],
    migrations: [isCompiled ? 'dist/database/migrations/*.js' : 'src/database/migrations/*.ts'],

    synchronize: false, // never let TypeORM alter the schema automatically
    logging:     false,
});
