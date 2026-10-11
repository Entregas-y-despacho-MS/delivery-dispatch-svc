# Contratos de mensajes (Pub/Sub)

JSON Schemas y ejemplos de los mensajes que Despachos intercambia con el ERP (Marketplace, Inventarios y Compras) sobre Google Cloud Pub/Sub. La fuente de verdad del catálogo es `docs/delivery-dispatch-docs/interoperabilidad-y-flujos.md`, sección 1.4.

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
4. Correr `npm run test`: la prueba de contratos falla si el catálogo y la carpeta no coinciden o si un ejemplo no valida.

El catálogo y esta carpeta se mantienen sincronizados: un tópico existe en ambos o en ninguno.

## Mapa tópico → archivos

Se completa a medida que se incorporan los tópicos (ver el catálogo para la descripción de cada uno).
