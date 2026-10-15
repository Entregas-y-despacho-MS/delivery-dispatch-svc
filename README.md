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
| `npm run simulate:marketplace` | ERP simulator: scenarios of Marketplace (see «Simulador ERP») |
| `npm run simulate:inventory` | ERP simulator: scenarios of Almacén |
| `npm run simulate:procurement` | ERP simulator: scenarios of Compras |
| `npm run simulate:listen` | Simulated consumer: prints what Despachos publishes |

## Docker
```bash
docker compose up --build
```

## Simulador ERP (ST-73.2)

Permite probar la mensajería con el ERP sin Marketplace, Almacén ni Compras reales: publica en el
emulador de Pub/Sub los mensajes de cada tópico de entrada y muestra lo que Despachos publica.
Solo habla con el emulador (`PUBSUB_EMULATOR_HOST`, `localhost:8085` por defecto): no puede publicar en
Google Cloud real.

### Requisitos
1. Emulador con los tópicos creados: `docker compose up` desde la raíz del workspace, o
   `node scripts/pubsub/bootstrap.mjs` si el emulador ya corre.
2. El backend corriendo con `MESSAGING_ADAPTER=pubsub` y el mismo `PUBSUB_EMULATOR_HOST` (para ver sus
   efectos: despachos, dead-letter, alertas). Sin el backend los mensajes esperan en las suscripciones.

### Comandos
| Comando | Qué hace |
|---|---|
| `npm run simulate:marketplace` | Lista los escenarios de Marketplace. |
| `npm run simulate:marketplace -- --scenario <nombre>` | Publica el escenario. |
| `npm run simulate:inventory` / `simulate:procurement` | Igual, para Almacén y Compras. |
| `npm run simulate:listen` | Escucha los tópicos `dispatch.*` y escribe cada mensaje en consola. |

Opciones de `simulate:*`: `--all` (todos los escenarios del origen que no esperan una solicitud),
`--run-id <texto>` (sufijo de los ids; aleatorio por defecto), `--as-is` (fixture tal cual: mismos ids y
fechas), `--delay <ms>` (espera entre mensajes, 300) y `--timeout <min>` (espera de la solicitud en los
escenarios de «mensaje perdido», 120).

Opciones de `simulate:listen`: `--topic <tópico>` (repetible) y `--dead-letters`, que muestra además los
rechazados de los tópicos de entrada. **Esta última confirma (ack) los mensajes que lee**: dejan de verse
en la suscripción `<tópico>.dead-letter.inspect`.

### Cómo funcionan los escenarios
Cada escenario es un archivo de `test/simulator/fixtures/<escenario>.json` con sus mensajes completos,
su descripción y el resultado esperado. En cada corrida el simulador:

- genera `messageId` nuevos (el mismo mensaje entregado dos veces conserva el suyo) y sufija el pedido
  (`SO-SIM-0001-<runId>`) para que una segunda corrida no sea ignorada por deduplicación;
- desplaza todas las fechas respecto del `anchor` del fixture, de modo que «ahora» es el instante de
  la corrida y una ventana de recogida nunca queda en el pasado (Compras la rechaza);
- publica por el tópico del `type` de cada mensaje, con los mismos atributos que el servicio.

### Escenarios y qué observar
| Origen | Escenario | Qué debe observarse |
|---|---|---|
| marketplace | `complete-order` | Se crea un despacho `pending`, visible en la bandeja (`GET /api/pending-orders`). El pedido lleva `confirmedAt` y los bultos `physicallyPacked`. |
| marketplace | `out-of-order` | Los bultos llegan antes que la confirmación; al llegar la segunda se crea el mismo despacho `pending`. |
| marketplace | `duplicate-message` | El mismo `messageId` llega dos veces; la segunda se ignora y hay un solo despacho. |
| marketplace | `stale-version` | Un cambio con `recordVersion` menor llega tarde y se ignora; vale la dirección de la versión mayor. |
| marketplace | `address-change` | El despacho existente toma la nueva dirección; no se crea otro. |
| marketplace | `cancellation` | El despacho pasa a `cancelled`. |
| marketplace | `invalid-message` | Falta `recipient`: el mensaje termina en `marketplace.sales_order.confirmed.dead-letter` (`schema_invalid`), queda alerta y no hay despacho. |
| marketplace | `lost-delivery-data` | «Mensaje perdido»: ver abajo. |
| inventory | `unknown-warehouse` | `warehouseId` inexistente: dead-letter de `inventory.shipment.ready` (`unknown_warehouse`), evento `integration.message_rejected`, sin despacho. |
| inventory | `packages-change` | El despacho `pending` pasa de uno a dos bultos. |
| inventory | `shipment-cancelled` | El despacho pasa a `cancelled`. |
| inventory | `invalid-shipment` | Falta `packages`: dead-letter por esquema. |
| inventory | `lost-shipment` | «Mensaje perdido» desde Almacén: ver abajo. |
| procurement | `pickup-requested` | Se crea un despacho de recogida en proveedor (`supplier_pickup`). |
| procurement | `pickup-window-change` | La recogida toma la nueva ventana y estimaciones. |
| procurement | `pickup-cancelled` | La recogida pasa a `cancelled`. |
| procurement | `duplicate-pickup` | La segunda entrega se ignora. |
| procurement | `invalid-pickup-window` | La ventana termina antes de empezar: dead-letter (`invalid_pickup_window`). |
| procurement | `invalid-pickup` | Falta `supplier`: dead-letter por esquema. |

Para ver un dead-letter: `npm run simulate:listen -- --dead-letters` en otra terminal.

### Escenario «mensaje perdido»
`lost-delivery-data` (Marketplace) y `lost-shipment` (Almacén) publican **una sola mitad** del pedido y
retienen la otra. El simulador queda suscrito a `dispatch.sync.requested` y, cuando Despachos la
solicita para ese pedido (`entityType` `sales_order` → Marketplace, `shipment` → Almacén), publica el
registro completo por su tópico habitual; el pedido se consolida y se crea el despacho `pending`.

```bash
npm run simulate:marketplace -- --scenario lost-delivery-data
```

La solicitud la emite la tarea de recuperación de `ST-50.5`, que corre cada 15 minutos (en los minutos
:00, :15, :30 y :45) y solo actúa sobre pedidos que llevan `incomplete_order_alert_minutes` esperando
(60 por defecto). Para verlo sin esperar una hora:

1. Baja la clave: `PUT /api/settings/incomplete_order_alert_minutes` con `{ "value": "1" }`
   (coordinador o root).
2. Corre el escenario y espera al siguiente cuarto de hora.
3. Devuelve la clave a su valor (60).

La tarea no tiene disparo manual (`POST /planning/*` solo cubre el generador y el corte). Un pedido que
no se completa recibe hasta 3 solicitudes, separadas por 15 minutos, y después una alerta
`incomplete_order_alert` / evento `integration.order_incomplete`.

### Pruebas
`npm run test` incluye `test/simulator/`: valida cada fixture contra su esquema (`contracts/messages/`)
y corre cada escenario contra los consumidores reales con adaptadores en memoria. No necesita Docker ni
PostgreSQL; la persistencia SQL la cubren los `*.integration.spec.ts` de cada consumidor.
