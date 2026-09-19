# delivery-dispatch-svc

Scaffolded with [create-nestkit](https://www.npmjs.com/package/@darkj/create-nestkit).

## Stack
- **NestJS 12** + TypeScript
- **TypeORM** + PostgreSQL
- **JWT auth** with refresh token rotation + role-based guards
- **Mailer** — SMTP or HTTP API (Resend-compatible), Port & Adapter pattern
- **WebSockets** — Socket.io
- **PDF generation** — Puppeteer
- **Swagger** at `/api/docs`, **Joi** env validation, global exception filter
- **Dockerfile** + **docker-compose.yml**

## Getting Started
```bash
cp .env.example .env   # fill in your values
npm run migration:run  # apply the initial schema
npm run seed            # create the root/admin/user roles + a root user
npm run start:dev
```

Swagger UI: `http://localhost:3000/api/docs`
Health check: `http://localhost:3000/api/health`

## Project Structure
```
src/
├── app/        # App-level logic (auth, health) — no own DB table
├── modules/    # Domain modules — one folder = one DB table
├── plugins/    # Port & Adapter pattern (mailer, socket, pdf)
├── database/   # TypeORM config, base entity, migrations, seeds
├── config/     # Global config module, env validation
└── shared/     # DTOs, filters, decorators, ORM utils
```

## Scripts
| Command | Description |
|---|---|
| `npm run start:dev` | Development server with watch |
| `npm run build` | Compile TypeScript |
| `npm run start:prod` | Run the compiled build |
| `npm run migration:generate -- src/database/migrations/<Name>` | Generate a migration from entity changes |
| `npm run migration:run` | Apply pending migrations |
| `npm run migration:revert` | Revert the last migration |
| `npm run seed` | Run the seed script |

## Docker
```bash
docker compose up --build
```

## Working with Claude Code
This project ships with a `.claude/` folder tailored to the plugins you selected:
- `.claude/rules/` — the conventions this codebase follows
- `.claude/commands/` — slash commands (`/nestjs/exception`, `/nestjs/plugin`, `/nestjs/module`, `/db/map`)
- `.claude/context/` — project journal; log decisions here as the project evolves past this starting point
