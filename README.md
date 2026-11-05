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

## Roles y matriz de permisos (ST-59.1, RF-A12)

Hay cinco roles paralelos: `ROOT`, `ADMIN`, `COORDINATOR`, `SUPERVISOR` y `DRIVER`. Ninguno implica los
permisos de otro: cada endpoint declara su lista con `@Roles(...)` (o un atajo como `@CoordinatorOnly()`).
`ROOT` es el único especial: salta toda comprobación y es una cuenta de emergencia, no de uso diario. Una ruta
sin decorador de rol admite a cualquier usuario autenticado, y las marcadas `@Public()` no piden token.

La matriz sale de los `@Roles` de los controladores y la verifica
`test/supervisor-permissions.e2e-spec.ts` con un token real de Supervisor (200 en lo permitido, 403 en lo
reservado). Debe coincidir con `PORTAL_ROUTES` del portal web (`config/portal-routes.ts`).

### Qué puede hacer el Supervisor

| Área | Endpoints | Supervisor |
|---|---|---|
| Despachos | `GET /dispatches/kanban`, `kanban/filters`, `:id/detail`, `history`, `history/export` | Sí |
| Despachos | `PATCH /dispatches/:id/priority` | Sí |
| Despachos | `GET /pending-orders`, `GET /dispatches/change-requests` | Sí |
| Lotes de ruta | `GET /route-batches`, `:id` | Sí |
| Lotes de ruta | `POST :id/approve-promises` (1.ª aprobación), `PATCH :id/reviewer`, `:id/driver`, `:id/vehicle` | Sí |
| Lotes de ruta | `POST :id/approve-final` (2.ª aprobación) | **No**, solo Coordinador |
| Planificación | `POST /planning/generate`, `/planning/cutoff`, `/dispatch-reservations/*` | **No**, solo Coordinador |
| Despachos | `POST :id/reschedule`, `:id/return`, `:id/cancel`, `:id/pickup-schedule`, `:id/pickup-reschedule`, `change-requests/:id/tracking-link` | **No**, solo Coordinador |
| Flota | `/vehicles` (CRUD), `GET`, `POST` y `PATCH :id/status` de `/vehicle-maintenances`, `/vehicle-incident-types` (`GET`, `POST`, `PUT`) | Sí |
| Catálogos | `GET /warehouses`, `GET /incident-reasons`, `GET /reschedule-reasons` | Sí (solo lectura) |
| Catálogos | `POST` y `PUT` de `/incident-reasons` y `/reschedule-reasons` | **No**, solo Coordinador (desde ST-59.1) |
| Catálogos | `/service-levels`, `/delivery-zones` | **No**, solo Coordinador |
| Ajustes | `GET /settings` (Administrador y Coordinador), `PUT /settings/:key` | **No** (ver «Pendiente») |
| Auditoría | `GET /audit/outbound-message-alerts` | **No**, solo Coordinador |
| Usuarios | `/users`, `/roles`, `POST /auth/register` | **No**, solo Administrador (el listado de `/users` y `/roles` también lo lee el Coordinador) |
| Repartidor | `my-assignments`, `my-history`, `drivers/me/metrics`, inicio y aceptación de lotes, estados, evidencias, OTP, incidencias, `supplier-pickup`, `arrived-at-warehouse`, `tracking/locations`, `push-tokens` | **No**, solo Repartidor |

Cualquier usuario autenticado, incluido el Supervisor, puede usar `POST /auth/logout`,
`PATCH /auth/change-password` y `/auth/2fa/*` sobre su propia cuenta.

### Pendiente: endpoints que aún no están en la matriz

| Tarea | Endpoint | Permiso previsto |
|---|---|---|
| `ST-60.1` | `GET /fleet/live-positions` | Supervisor y Coordinador |
| `ST-61.1` | `GET /fleet/kpis` | Por definir |
| `ST-62.1` | `PATCH /vehicles/:id/status` | Supervisor y Coordinador |
| `ST-63.1` | `POST /route-batches/:id/reassign` | Supervisor |
| `ST-67.1` | `GET /settings/alert-thresholds` (Supervisor y Coordinador), `PUT /settings/alert-thresholds` (solo Supervisor) | Los umbrales del Supervisor van en su propio endpoint; `/settings` no cambia |

Quien agregue uno de estos endpoints añade su fila a la tabla de arriba y su caso a
`test/supervisor-permissions.e2e-spec.ts`.

## Push notifications

The default provider is Expo (`PUSH_PROVIDER=expo`). The Expo Server SDK sends one notification to
each active device token after the second approval of a route batch. Its data includes the first
dispatch ID from the immutable approval event, the zone, and an aggregate priority (`urgent` if any
dispatch in the batch is urgent, otherwise `normal`); the body reports the confirmed batch count.
Set `EXPO_ACCESS_TOKEN` when push security is enabled for the Expo project. Expo delivery receipts
are polled every 15 minutes; pending receipt IDs are held in process memory and can be lost if the
server restarts before polling.

Firebase Admin is available as an alternative with `PUSH_PROVIDER=firebase` and the
`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` settings. Firebase expects
an installation ID, so the mobile token registration must match the selected provider.

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

### Actualizar la imagen base

El `Dockerfile` fija `node:22-bookworm-slim` por digest (el mismo valor en las tres etapas `FROM`). Eso hace el
build reproducible, pero la imagen queda congelada y no recibe parches de seguridad. Cada uno o dos meses, o ante un
aviso de seguridad de Node o Debian, obtén el digest vigente con
`docker buildx imagetools inspect node:22-bookworm-slim` (campo `Digest` de nivel superior), reemplázalo en las tres
líneas `FROM` y comprueba con `docker build .`.

## Consumir un topic real de Google Cloud Pub/Sub

El adaptador usa Google Application Default Credentials cuando `PUBSUB_EMULATOR_HOST` no está definido.
Para recibir varios tipos de evento desde un mismo topic, configura una subscription de GCP dedicada al
backend. El backend enruta cada mensaje por el campo JSON `type` y luego lo valida con el contrato lógico
correspondiente. La publicación de salida del backend continúa usando los topics `dispatch.*`.

Para el topic del Grupo H (`projects/project-a96e5fe1-5ba6-4698-a85/topics/ucb-sis323-sub-h`), usa:

```dotenv
MESSAGING_ADAPTER=pubsub
PUBSUB_PROJECT_ID=project-a96e5fe1-5ba6-4698-a85
PUBSUB_INBOUND_TOPIC=ucb-sis323-sub-h
PUBSUB_INBOUND_SUBSCRIPTION=ucb-sis323-sub-h-dispatch-svc
# PUBSUB_EMULATOR_HOST debe estar vacío o sin definir para usar GCP real.
```

El nombre completo que pasaste es el **topic**. La subscription es otro recurso y debe apuntar a ese topic.
Para el proceso local, configura las credenciales que usará la librería de Pub/Sub:

```bash
gcloud auth application-default login
```

Para crear la subscription y preparar los topics de dead-letter que usa el backend, autentícate con `gcloud`
en el proyecto y ejecuta desde la carpeta del servicio:

```bash
export PUBSUB_PROJECT_ID=project-a96e5fe1-5ba6-4698-a85
export PUBSUB_INBOUND_TOPIC=ucb-sis323-sub-h
export PUBSUB_INBOUND_SUBSCRIPTION=ucb-sis323-sub-h-dispatch-svc
unset PUBSUB_EMULATOR_HOST
./scripts/pubsub/setup-gcp-subscription.sh
```

El proceso del backend debe tener ADC configuradas y permiso `roles/pubsub.subscriber` sobre la subscription,
además de `roles/pubsub.publisher` sobre los topics de dead-letter. Si también publica mensajes de salida, necesita
permiso de publicación en los topics `dispatch.*` correspondientes. La subscription debe ser exclusiva de esta
instancia lógica del backend: Pub/Sub reparte cada mensaje entre los consumidores que comparten una subscription.
El helper crea la dead-letter del broker `<topic>.delivery-failures` y concede al service agent de Pub/Sub los permisos
`roles/pubsub.subscriber` sobre la subscription y `roles/pubsub.publisher` sobre esa dead-letter, que necesita para
reenviar mensajes tras agotar los intentos. Si la subscription ya existía, el helper verifica que apunte al topic
correcto y deja intacta su política actual.

Inicia el backend con esas variables de entorno y publica eventos desde el sistema emisor al topic. No configures
`PUBSUB_EMULATOR_HOST`: si lo dejas apuntando al emulador, el cliente no llegará a Google Cloud.

### Publicar en Grupo H y procesar una copia local

Cuando no tengas permisos de suscripción en GCP, puedes publicar los eventos en el topic real y enviar una copia
idéntica al emulador local. El backend procesa la copia local con sus suscripciones habituales; esto no valida el
consumo desde GCP.

Levanta el stack local desde la carpeta raíz del workspace. El publicador corre como contenedor temporal; la cuenta
de servicio se monta solo en lectura:

```bash
docker compose up -d --build delivery-dispatch-svc
docker compose run --rm --no-deps \
  -v "/ruta/a/service-account.json:/run/gcp/service-account.json:ro" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/run/gcp/service-account.json \
  -e PUBSUB_PROJECT_ID=project-a96e5fe1-5ba6-4698-a85 \
  -e PUBSUB_INBOUND_TOPIC=ucb-sis323-sub-h \
  -e LOCAL_PUBSUB_EMULATOR_HOST=pubsub-emulator:8085 \
  delivery-dispatch-svc node scripts/pubsub/publish-grupo-h-and-simulate.mjs
```

`PUBSUB_PROJECT_ID` y `PUBSUB_INBOUND_TOPIC` son obligatorios (el script falla si faltan): no hay valores por
defecto para evitar publicar por descuido en el topic compartido. Sin argumento, genera un pedido manual y publica `marketplace.sales_order.confirmed` seguido de
`inventory.shipment.ready`. También puedes pasar un archivo JSON con un sobre o una lista de sobres:

```bash
docker compose run --rm --no-deps \
  -v "/ruta/a/service-account.json:/run/gcp/service-account.json:ro" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/run/gcp/service-account.json \
  -e PUBSUB_PROJECT_ID=project-a96e5fe1-5ba6-4698-a85 \
  -e PUBSUB_INBOUND_TOPIC=ucb-sis323-sub-h \
  -e LOCAL_PUBSUB_EMULATOR_HOST=pubsub-emulator:8085 \
  delivery-dispatch-svc node scripts/pubsub/publish-grupo-h-and-simulate.mjs /ruta/a/eventos.json
```

Cada sobre se publica en el topic físico de Grupo H y luego, sin cambiar su contenido, en el topic lógico homónimo
del emulador (`message.type`) para que el backend local lo procese. El envío a GCP ocurre primero; si falla después
la copia local, el mensaje de GCP ya quedó publicado. Repetir el comando genera un nuevo pedido cuando se usan los
mensajes de ejemplo.

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
3. Una **zona de entrega cuyo polígono cubra la dirección de los fixtures** (`-16.5115, -68.1223` y
   `-16.5421, -68.0802`, en La Paz). El seed no trae zonas y la API de zonas no dibuja el polígono
   (`boundary`). Sin esa zona el despacho se crea igual, pero en `address_review` (solo lectura en la
   bandeja, `zoneId: null`) y no en `pending`. Para el entorno de desarrollo:
   ```sql
   -- crea la zona con POST /api/delivery-zones (code ZON-SIM) o usa una existente, y dibuja el límite
   -- (longitud, latitud); este rectángulo cubre el centro y el sur de La Paz:
   UPDATE delivery_zones
      SET boundary = polygon '((-68.20,-16.60),(-68.00,-16.60),(-68.00,-16.40),(-68.20,-16.40))'
    WHERE code = 'ZON-SIM';
   ```
   Los pedidos ya creados en `address_review` no cambian: corre el escenario de nuevo.

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
| marketplace | `complete-order` | Se crea un despacho `pending`, visible en la bandeja (`GET /api/pending-orders`) con su zona asignada (requiere la zona del requisito 3; sin ella queda en `address_review`). El pedido lleva `confirmedAt` y los bultos `physicallyPacked`. |
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
| inventory | `rma-requested` | Devolución aprobada (RMA, `inventory.return.requested`) con coordenadas: se crea un recojo domiciliario `warehouse_return_pickup` en `pickup_scheduled` con destino `WH-LPZ-01` y la web recibe `dispatch.status_changed`. Ver «Demo de devoluciones (RMA)». |
| inventory | `rma-without-coordinates` | RMA sin coordenadas: el recojo queda en `address_review`, no en `pickup_scheduled`. |
| inventory | `rma-unknown-warehouse` | `warehouseId` inexistente: dead-letter de `inventory.return.requested` (`unknown_warehouse`), `integration.message_rejected` y sin recojo. |
| inventory | `rma-invalid` | Falta `returnReason`: dead-letter por esquema (`schema_invalid`), alerta y sin recojo. |
| inventory | `rma-duplicate` | El mismo `messageId` llega dos veces; la segunda se ignora (un recojo, un solo evento). |
| inventory | `rma-stale-version` | Llega la versión 3 y después la 2 del mismo RMA; la 2 se ignora y el recojo conserva la dirección de la 3. |
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

### Demo de devoluciones (RMA) — `ES-238`
Integración entrante de Almacén: al aprobar una devolución publica `inventory.return.requested` y
Despachos crea el recojo domiciliario sin intervención del coordinador. Requisitos: los de arriba
(emulador y backend con `MESSAGING_ADAPTER=pubsub`); **no** hace falta la zona de entrega, porque el
recojo no se asigna a una zona al crearse.

```bash
npm run simulate:inventory -- --scenario rma-requested
```

Publica un RMA `RMA-SIM-0001-<runId>` con su dirección en La Paz, un bulto estimado y fecha de recojo
preferida dos días después. Qué debe observarse:

1. **Recojo creado:** un despacho `warehouse_return_pickup` en `pickup_scheduled`, con
   `source_order_ref` igual al `rmaId`, el almacén `WH-LPZ-01` como destino, el motivo y los bultos, y
   un evento `created_from_rma` en su historial:
   ```sql
   SELECT d.dispatch_id, ds.name AS status, d.source_order_ref, d.return_reason, d.estimated_boxes
     FROM dispatches d JOIN dispatch_statuses ds USING (dispatch_status_id)
    WHERE d.source_order_ref LIKE 'RMA-SIM-%' ORDER BY d.dispatch_id DESC;
   ```
2. **Web:** el recojo aparece en la página **Recojos** (`GET /api/pickup-orders`) con origen RMA, y la
   lista se refresca sola al llegar el evento `dispatch.status_changed` (sala de coordinadores y
   supervisores). *Esa página y el endpoint son `ST-81.1` y `ST-81.2`, aún «Por hacer» en el Sprint 3:
   mientras no estén, el recojo se comprueba con la consulta anterior y el evento por socket.*
3. **Otros resultados:** con `rma-without-coordinates` el recojo queda en `address_review`; con
   `rma-unknown-warehouse` y `rma-invalid` no se crea nada, el mensaje va a
   `inventory.return.requested.dead-letter` (`npm run simulate:listen -- --dead-letters`) y aparece la
   alerta `integration.message_rejected`; con `rma-duplicate` y `rma-stale-version` hay un solo recojo.

Cada corrida usa un `runId` distinto, así que se puede repetir sin que la deduplicación la ignore.
`--all` publica todos los escenarios de Almacén, los RMA incluidos.

### Pruebas
`npm run test` incluye `test/simulator/`: valida cada fixture contra su esquema (`contracts/messages/`)
y corre cada escenario contra los consumidores reales con adaptadores en memoria. No necesita Docker ni
PostgreSQL; la persistencia SQL la cubren los `*.integration.spec.ts` de cada consumidor.

El circuito completo del RMA (mensaje → recojo `pickup_scheduled` → evento por socket; inválido →
dead-letter y alerta) lo recorre `src/modules/messaging/rma-pickup-intake/rma-pickup.integration.spec.ts`
con el adaptador en memoria y el `DispatchEventsSocketListener` real.
