# delivery-dispatch-svc

Backend del microservicio de **Gestión de Entregas y Despachos** del ERP: planifica rutas y lotes
de reparto, gestiona su aprobación y ejecución, da seguimiento público al cliente final, y se
integra por mensajería asíncrona (Google Cloud Pub/Sub) con Marketplace, Almacén y Compras.

Scaffolded con [create-nestkit](https://www.npmjs.com/package/@darkj/create-nestkit).

## Tabla de contenidos
- [Stack](#stack)
- [Getting Started](#getting-started)
- [Roles y permisos](#roles-y-permisos)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Scripts](#scripts)
- [Docker](#docker)
- [Documentación adicional](#documentación-adicional)

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
npm run seed            # create the 5 roles + a root user + a development Supervisor user
npm run start:dev
```

Swagger UI: `http://localhost:3000/api/docs`
Health check: `http://localhost:3000/api/health`

### Usuarios de desarrollo (seed)

`npm run seed` es idempotente (se puede correr varias veces) y crea:

| Usuario | Rol | Variables que lo personalizan |
|---|---|---|
| `root` | `ROOT` | `SEED_ROOT_USERNAME`, `SEED_ROOT_FULL_NAME`, `SEED_ROOT_EMAIL`, `SEED_ROOT_PASSWORD` |
| `supervisor` | `SUPERVISOR` | `SEED_SUPERVISOR_USERNAME`, `SEED_SUPERVISOR_FULL_NAME`, `SEED_SUPERVISOR_EMAIL`, `SEED_SUPERVISOR_PASSWORD` |

Los valores por defecto están en `src/database/seeds/seed.ts`. Son solo para desarrollo: en cualquier otro
entorno define las contraseñas por variable de entorno. Los usuarios del resto de los roles (administrador,
coordinador, repartidor) se crean con `POST /api/users`.

## Roles y permisos

Cinco roles paralelos: `ROOT`, `ADMIN`, `COORDINATOR`, `SUPERVISOR` y `DRIVER`. Ninguno implica los permisos
de otro — cada endpoint declara su lista con `@Roles(...)`. `ROOT` salta toda comprobación (cuenta de
emergencia, no de uso diario); una ruta sin decorador de rol admite a cualquier usuario autenticado, y las
marcadas `@Public()` no piden token.

La matriz completa, endpoint por endpoint, está en **[docs/roles-and-permissions.md](docs/roles-and-permissions.md)**
y la verifica `test/supervisor-permissions.e2e-spec.ts` contra un token real de Supervisor.

## Testing

| Comando | Qué corre |
|---|---|
| `npm run lint` | `oxlint` sobre `src/` y `test/` |
| `npm run build` | Compila con `nest build` |
| `npm test` | Valida los contratos de mensajería contra el catálogo de `delivery-dispatch-docs` y corre los tests unitarios (`vitest run`) |
| `npm run test:e2e` | Suite e2e (`vitest run --config vitest.config.e2e.ts`) contra una base PostgreSQL real — no corren en paralelo entre archivos, ver abajo |

Los e2e levantan el `AppModule` real contra una base de datos real (no mocks de TypeORM) — necesitan
el schema de `delivery-dispatch-db` (repo hermano) ya cargado. Cada archivo de e2e corre contra la
misma base de forma secuencial (`fileParallelism: false`): un archivo que crea o borra filas
cambiaría lo que otro cuenta o lista si corrieran en paralelo. El routing se simula con un
`FakeOsrm` inyectado (`OsrmPort`), así que no hace falta OSRM real corriendo; mensajería y caché
usan adaptadores en memoria durante los e2e (`MESSAGING_ADAPTER=memory`, `CACHE_ADAPTER=memory`).

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
| `npm run simulate:marketplace` / `simulate:inventory` / `simulate:procurement` / `simulate:demo-returns` | ERP simulator — see [docs/erp-simulator.md](docs/erp-simulator.md) |
| `npm run simulate:listen` | Simulated consumer: prints what Despachos publishes |

## Docker
```bash
docker compose up --build
```

El `Dockerfile` fija `node:22-bookworm-slim` por digest (el mismo valor en las tres etapas `FROM`), para un
build reproducible. Para refrescarlo: `docker buildx imagetools inspect node:22-bookworm-slim` (campo
`Digest` de nivel superior), reemplazarlo en las tres líneas `FROM` y comprobar con `docker build .`.

## Documentación adicional

Detalle técnico que no hace falta leer para levantar o entender el proyecto a alto nivel:

- **[Roles y matriz de permisos completa](docs/roles-and-permissions.md)** — tabla endpoint por endpoint.
- **[Push notifications](docs/push-notifications.md)** — proveedores Expo/Firebase y su configuración.
- **[Integración con Google Cloud Pub/Sub](docs/pubsub-integration.md)** — consumir un topic real, credenciales, dead-letters.
- **[Simulador ERP](docs/erp-simulator.md)** — probar la mensajería con el ERP sin Marketplace, Almacén ni Compras reales.
