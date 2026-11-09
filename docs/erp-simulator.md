# Simulador ERP

Permite probar la mensajería con el ERP sin Marketplace, Almacén ni Compras reales: publica en el
emulador de Pub/Sub los mensajes de cada tópico de entrada y muestra lo que Despachos publica.
Solo habla con el emulador (`PUBSUB_EMULATOR_HOST`, `localhost:8085` por defecto): no puede publicar en
Google Cloud real.

## Requisitos
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

## Comandos
| Comando | Qué hace |
|---|---|
| `npm run simulate:marketplace` | Lista los escenarios de Marketplace. |
| `npm run simulate:marketplace -- --scenario <nombre>` | Publica el escenario. |
| `npm run simulate:inventory` / `simulate:procurement` | Igual, para Almacén y Compras. |
| `npm run simulate:demo-returns` | Igual, para la recepción de Almacén; ver «Demo de recepción». |
| `npm run simulate:listen` | Escucha los tópicos `dispatch.*` y escribe cada mensaje en consola. |

Opciones de `simulate:*`: `--all` (todos los escenarios del origen que no esperan una solicitud),
`--run-id <texto>` (sufijo de los ids; aleatorio por defecto), `--as-is` (fixture tal cual: mismos ids y
fechas), `--delay <ms>` (espera entre mensajes, 300), `--pause <s>` (espera antes de la recepción en los
escenarios que la llevan: 0 por defecto, 30 en `simulate:demo-returns`) y `--timeout <min>` (espera de la solicitud en los
escenarios de «mensaje perdido», 120).

Opciones de `simulate:listen`: `--topic <tópico>` (repetible) y `--dead-letters`, que muestra además los
rechazados de los tópicos de entrada. **Esta última confirma (ack) los mensajes que lee**: dejan de verse
en la suscripción `<tópico>.dead-letter.inspect`.

## Cómo funcionan los escenarios
Cada escenario es un archivo de `test/simulator/fixtures/<escenario>.json` con sus mensajes completos,
su descripción y el resultado esperado. En cada corrida el simulador:

- genera `messageId` nuevos (el mismo mensaje entregado dos veces conserva el suyo) y sufija el pedido
  (`SO-SIM-0001-<runId>`) para que una segunda corrida no sea ignorada por deduplicación;
- desplaza todas las fechas respecto del `anchor` del fixture, de modo que «ahora» es el instante de
  la corrida y una ventana de recogida nunca queda en el pasado (Compras la rechaza);
- publica por el tópico del `type` de cada mensaje, con los mismos atributos que el servicio.

## Escenarios y qué observar
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
| inventory | `rma-reserved-prefix` | `rmaId` con el prefijo `MANUAL-` (reservado a los recojos que registra el coordinador): dead-letter de `inventory.return.requested` (`reserved_rma_prefix`), `integration.message_rejected` y sin recojo. |
| inventory | `rma-invalid` | Falta `returnReason`: dead-letter por esquema (`schema_invalid`), alerta y sin recojo. |
| inventory | `rma-duplicate` | El mismo `messageId` llega dos veces; la segunda se ignora (un recojo, un solo evento). |
| inventory | `rma-stale-version` | Llega la versión 3 y después la 2 del mismo RMA; la 2 se ignora y el recojo conserva la dirección de la 3. |
| procurement | `pickup-requested` | Se crea un despacho de recogida en proveedor (`supplier_pickup`). |
| procurement | `pickup-window-change` | La recogida toma la nueva ventana y estimaciones. |
| procurement | `pickup-cancelled` | La recogida pasa a `cancelled`. |
| procurement | `duplicate-pickup` | La segunda entrega se ignora. |
| procurement | `invalid-pickup-window` | La ventana termina antes de empezar: dead-letter (`invalid_pickup_window`). |
| procurement | `invalid-pickup` | Falta `supplier`: dead-letter por esquema. |
| demo-returns | `receipt-rma-complete` | RMA + recepción completa. Con el recojo en `picked_up_in_transit`: pasa a `returned_to_warehouse` (cerrado); no se publica nada a Inventarios. |
| demo-returns | `receipt-rma-damaged` | RMA + recepción con un equipo dañado: `incident` con la incidencia `INC-RECEIPT-DIFF`, `dispatch.transfer.status_changed` hacia Inventarios (`salesOrderId` = RMA) y `dispatch.incident_reported` en la web. |
| demo-returns | `receipt-pickup-complete` | Recogida en proveedor + recepción completa: `delivered` y mensaje a Compras con `result complete` y sin ítems. |
| demo-returns | `receipt-pickup-missing` | Recogida + recepción con faltantes: `incident`, mensaje a Compras con `result with_differences` y solo los ítems con diferencias. |
| demo-returns | `receipt-unknown-reference` | Recepción de una orden de compra desconocida: recepción `orphan`, nada cambia y `dispatch.change_requires_attention` (`orphan_receipt`). |
| demo-returns | `receipt-not-picked-up` | RMA + recepción antes de que se recoja (`pickup_scheduled`): `orphan`; el despacho no se mueve. |
| demo-returns | `receipt-invalid` | Recepción sin `items`: dead-letter de `inventory.receipt.confirmed` (`schema_invalid`) y alerta. |
| demo-returns | `receipt-duplicate` | RMA + la misma recepción entregada dos veces: la segunda se ignora (una recepción, un cambio de estado). |

Para ver un dead-letter: `npm run simulate:listen -- --dead-letters` en otra terminal.

## Escenario «mensaje perdido»
`lost-delivery-data` (Marketplace) y `lost-shipment` (Almacén) publican **una sola mitad** del pedido y
retienen la otra. El simulador queda suscrito a `dispatch.sync.requested` y, cuando Despachos la
solicita para ese pedido (`entityType` `sales_order` → Marketplace, `shipment` → Almacén), publica el
registro completo por su tópico habitual; el pedido se consolida y se crea el despacho `pending`.

```bash
npm run simulate:marketplace -- --scenario lost-delivery-data
```

La solicitud la emite una tarea de recuperación periódica, que corre cada 15 minutos (en los minutos
:00, :15, :30 y :45) y solo actúa sobre pedidos que llevan `incomplete_order_alert_minutes` esperando
(60 por defecto). Para verlo sin esperar una hora:

1. Baja la clave: `PUT /api/settings/incomplete_order_alert_minutes` con `{ "value": "1" }`
   (coordinador o root).
2. Corre el escenario y espera al siguiente cuarto de hora.
3. Devuelve la clave a su valor (60).

La tarea no tiene disparo manual (`POST /planning/*` solo cubre el generador y el corte). Un pedido que
no se completa recibe hasta 3 solicitudes, separadas por 15 minutos, y después una alerta
`incomplete_order_alert` / evento `integration.order_incomplete`.

## Demo de devoluciones (RMA)
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
   supervisores). *La página web correspondiente todavía no existe: mientras no esté, se comprueba con
   `GET /api/pickup-orders?origin=rma` y el evento por socket.*
3. **Otros resultados:** con `rma-without-coordinates` el recojo queda en `address_review`; con
   `rma-unknown-warehouse`, `rma-reserved-prefix` y `rma-invalid` no se crea nada, el mensaje va a
   `inventory.return.requested.dead-letter` (`npm run simulate:listen -- --dead-letters`) y aparece la
   alerta `integration.message_rejected`; con `rma-duplicate` y `rma-stale-version` hay un solo recojo.

Cada corrida usa un `runId` distinto, así que se puede repetir sin que la deduplicación la ignore.
`--all` publica todos los escenarios de Almacén, los RMA incluidos.

## Demo de recepción
Almacén confirma con `inventory.receipt.confirmed` lo que llegó a su bodega; Despachos cierra el traslado
(`returned_to_warehouse` o `delivered`) o abre una incidencia. Solo se aplica sobre un despacho en
`picked_up_in_transit`, y ese estado lo da el recojo real, así que el simulador **publica primero el RMA (o la
solicitud de recogida) y espera `--pause` segundos** antes de la recepción: es el tiempo para llevar el despacho a
`picked_up_in_transit` (con el repartidor, o en una base de pruebas con un `UPDATE` del estado).

```bash
npm run simulate:demo-returns -- --scenario receipt-rma-complete --pause 60
npm run simulate:demo-returns -- --scenario receipt-pickup-missing --pause 60
```

Sin `--scenario` lista los ocho escenarios. Mientras corre, `npm run simulate:listen` muestra lo que Despachos
publica (`dispatch.transfer.status_changed` hacia Compras o Inventarios, según el escenario). Con `--pause 0` la
recepción llega con el despacho aún en `pickup_scheduled` y queda `orphan`, igual que `receipt-not-picked-up`.

## Pruebas del simulador
`npm run test` incluye `test/simulator/`: valida cada fixture contra su esquema (`contracts/messages/`)
y corre cada escenario contra los consumidores reales con adaptadores en memoria. No necesita Docker ni
PostgreSQL; la persistencia SQL la cubren los `*.integration.spec.ts` de cada consumidor.

El circuito completo del RMA (mensaje → recojo `pickup_scheduled` → evento por socket; inválido →
dead-letter y alerta) lo recorre `src/modules/messaging/rma-pickup-intake/rma-pickup.integration.spec.ts`
con el adaptador en memoria y el `DispatchEventsSocketListener` real.
