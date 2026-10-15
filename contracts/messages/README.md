# Contratos de mensajes (Pub/Sub)

JSON Schemas y ejemplos de los mensajes que Despachos intercambia con el ERP (Marketplace, Inventarios y Compras) sobre Google Cloud Pub/Sub. La fuente de verdad del catálogo es `../delivery-dispatch-docs/interoperabilidad-y-flujos.md`, sección 1.4.

## Estructura

```text
contracts/messages/
├── README.md                          # este documento
├── envelope.schema.json               # sobre común (1.3) y definiciones reutilizables ($defs)
├── schemas/<topico>.schema.json       # un esquema por tópico
└── examples/<topico>.example.json     # un mensaje válido por tópico
```

El nombre de archivo es exactamente el nombre del tópico, por ejemplo `inventory.shipment.ready.schema.json`.

## Convenciones

| Aspecto | Regla |
|---|---|
| Dialecto | JSON Schema 2020-12. |
| Sobre | Todo mensaje lleva `messageId` (UUID v7), `type`, `schemaVersion`, `source`, `occurredAt` y `data`. |
| `type` | Cada esquema lo fija con `const` al nombre del tópico. |
| `schemaVersion` | Entero desde 1. Versiona el contenido de `data`, no el nombre del tópico. Todo cambio incompatible sube la versión. |
| Fechas | ISO-8601 en UTC con sufijo `Z` (`2026-10-07T14:03:00Z`). |
| Unidades | Peso en kilogramos (`...Kg`), medidas en centímetros (`...Cm`), coordenadas WGS84 (`latitude`, `longitude`). |
| Versión de registro | `data` lleva el ID original del registro, `updatedAt` y `recordVersion` creciente (idempotencia por versión). |
| Campos extra | `additionalProperties: false` en el sobre y en `data`: un campo no declarado invalida el mensaje. |
| Datos personales | Los mensajes salientes de estado no incluyen datos personales ni `tracking_token`. |

Un mensaje que no valida no crea ni modifica registros: se envía al tópico de mensajes rechazados (dead-letter) con el detalle del error.

## Definiciones compartidas

Se referencian con `$ref` a `envelope.schema.json#/$defs/<nombre>`:

`messageId`, `topic`, `schemaVersion`, `source`, `dateTimeUtc`, `recordVersion`, `entityId`, `geoPoint`, `package`, `evidencePolicy`, `handlingCondition`.

## Cómo agregar o cambiar un tópico

1. Agregar la fila al catálogo de `interoperabilidad-y-flujos.md` (sección 1.4).
2. Crear `schemas/<topico>.schema.json` y `examples/<topico>.example.json`.
3. Si el cambio es incompatible con la versión vigente, subir `schemaVersion` en esquema y ejemplo.
4. Correr `npm run contracts:check` y `npm test`: el verificador compara catálogo, esquemas, ejemplos y fixtures del simulador; `npm test` lo ejecuta antes de Vitest.

El catálogo se busca en el repositorio hermano `delivery-dispatch-docs`, tanto desde un checkout normal como desde un worktree. Si está en otra ubicación, se puede indicar con `CONTRACTS_CATALOG_PATH` (ruta absoluta al archivo `interoperabilidad-y-flujos.md`). Si no se encuentra, la verificación falla con una instrucción para configurarlo.

El catálogo y esta carpeta se mantienen sincronizados: un tópico existe en ambos o en ninguno.

## Mapa tópico → archivos

Cada fila corresponde a `schemas/<tópico>.schema.json` y `examples/<tópico>.example.json`. La descripción de cada tópico está en el catálogo (sección 1.4 del documento).

**Mensajes que recibe Despachos**

| Tópico | Emisor (`source`) | Notas del contrato |
|---|---|---|
| `marketplace.sales_order.confirmed` | `marketplace` | `confirmedAt` obligatorio (D0). `deliveryAddress.location` opcional: sin coordenadas el despacho queda en `address_review`. Sin datos de pago. |
| `marketplace.sales_order.updated` | `marketplace` | Cada bloque enviado reemplaza completo al anterior; exige al menos un cambio. |
| `marketplace.sales_order.cancelled` | `marketplace` | `cancelledAt` obligatorio. |
| `inventory.shipment.ready` | `inventory` | `packages` con medidas (cm) y peso (kg). `physicallyPacked` opcional (por defecto `false`), no gobierna la salida. `evidencePolicy` opcional. |
| `inventory.shipment.updated` | `inventory` | `isReady: false` indica que el pedido deja de estar listo. |
| `inventory.shipment.cancelled` | `inventory` | Retiro cancelado por Almacén. |
| `inventory.return.requested` | `inventory` | RMA con contacto y dirección de recojo. Sprint 3. |
| `inventory.receipt.confirmed` | `inventory` | `referenceType` (`rma` o `purchase_order`) y cantidades aceptadas, faltantes y dañadas. |
| `procurement.pickup.requested` | `procurement` | Crea un `supplier_pickup`; dirección, almacén y horario opcionales: si falta uno imprescindible, queda en `address_review`. Estimaciones en kg y m³; `transportConditions` admite condiciones especiales como fragilidad o temperatura. |
| `procurement.pickup.updated` | `procurement` | Cada bloque enviado reemplaza completo al anterior; exige al menos un cambio. Solo se aplica a despachos `pending`, `address_review` o `scheduled`; `transportConditions` reemplaza la lista anterior al enviarse. |
| `procurement.pickup.cancelled` | `procurement` | `cancelledAt` obligatorio. Solo cancela despachos `pending`, `address_review` o `scheduled`; cambios fuera de esos estados se registran y generan una alerta al coordinador. |

**Mensajes que publica Despachos**

| Tópico | Destinatario | Notas del contrato |
|---|---|---|
| `dispatch.shipment.prepare_requested` | Inventarios | `recordVersion` obligatorio: una versión mayor reemplaza a la anterior. `departureDate` es una fecha calendario (`YYYY-MM-DD`). |
| `dispatch.shipment.departed` | Inventarios | Un mensaje por pedido: `departedAt`, `driverId` y `packageIds`. |
| `dispatch.pickup.scheduled` | Compras | `pickupWindow` en UTC; una reprogramación sube `recordVersion`. |
| `dispatch.sync.requested` | Marketplace / Inventarios | `entityType`: `sales_order` va a Marketplace y `shipment` va a Inventarios. Reintentos cada 15 minutos, máximo 3 por pedido. |
| `dispatch.transfer.status_changed` | Marketplace / Compras / Inventarios | Exactamente uno de `salesOrderId` o `purchaseOrderId`. Sin datos personales ni `tracking_token`. |
| `dispatch.transfer.incident_reported` | Marketplace / Compras | `reasonCode` del catálogo `incident_reasons` y `nextStep` decidido por Despacho. |

## Publicación y entrega

La tarea `incomplete-order-recovery` revisa cada 15 minutos los pedidos pendientes que superaron
`incomplete_order_alert_minutes` (60 minutos por defecto). Solicita al origen faltante su registro
completo; si después del tercer intento el pedido continúa incompleto, emite el evento interno
`dispatch.change_requires_attention` con `changeType: incomplete_order` y el `salesOrderId`.

- **Entrega al menos una vez.** Despachos publica por una *outbox* y puede enviar el mismo `messageId` más de una vez (un reintento tras un fallo de confirmación, o una instancia que retoma un mensaje). Quien consume debe ignorar un `messageId` ya procesado y un `recordVersion` menor o igual al almacenado.
- **Reintentos de los mensajes salientes** (D-54 de `decisiones-planificacion-semiautomatica.md`): si el broker no responde, se reintenta tras 1 s, 2 s y 4 s y luego cada minuto, hasta 4 horas desde que se encoló. Al tercer fallo queda una alerta de demora en la auditoría técnica; vencidas las 4 horas, el mensaje queda `failed` con otra alerta y no se reintenta solo.
- **Mensajes entrantes inválidos** van a `<tópico>.dead-letter` con `{ originalTopic, rejectedAt, errors, message }`. Si el emisor corrige el mensaje y lo reenvía con el **mismo** `messageId`, se procesa (el rechazo no «quema» el identificador).

## Decisiones de contrato

- **`handlingCondition` y `reasonCode` son patrones, no enums cerrados.** Sus catálogos pueden crecer en el origen; un valor nuevo no debe mandar el mensaje al dead-letter.
- **`evidencePolicy` sí es enum cerrado** y coincide con el `CHECK` de `dispatch.dispatches.evidence_policy`: `hand_delivery_standard`, `contactless_delivery`, `high_value_control`.
- **Resolución de `$ref`:** los esquemas se referencian por `$id` (`https://contracts.delivery-dispatch.local/messages/...`). Un validador debe registrar `envelope.schema.json` y todos los de `schemas/` antes de compilar. Son compatibles con `ajv` 2020-12 en modo `strict`.
- **Unidades:** además de kg y cm, las estimaciones de Compras usan metros cúbicos (`volumeM3`), igual que `vehicles.capacity_m3`.
