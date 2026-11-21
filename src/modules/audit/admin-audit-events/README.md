# Auditoría de acciones administrativas sensibles (RF-A35)

Registra quién ejecutó o intentó una acción administrativa sensible, con qué rol, sobre qué entidad, con qué resultado y en qué solicitud. Tabla `admin_audit_events` de `delivery-dispatch-db` (migración `028_20261119_1430_create_admin_audit_events`).

## Cómo instrumentar un handler

```ts
@Patch(':id/role')
@AuditAction('user.role_changed', { bodyFields: ['roleId'] })
async updateRole(...) { ... }
```

| Opción | Uso |
|---|---|
| acción | Una del catálogo de abajo (`domain/admin-audit-catalog.ts`); el tipo de entidad sale de ahí, nunca del request. |
| `entityIdParam` | Parámetro de ruta con el id de la entidad. `'id'` por defecto; `null` si la acción no tiene id. |
| `entityIdFrom` | De dónde sale el id de la entidad: `'param'` (por defecto, el parámetro `entityIdParam`), `'response'` (el `id` del objeto que devuelve el handler: altas; si la llamada falla no hay id) o `'actor'` (el usuario autenticado: acciones sobre la propia cuenta, como la contraseña o el 2FA). |
| `metadata` | Valores fijos que el handler agrega a `metadata` (por ejemplo `{ step: 'enable' }` para distinguir qué operación de la acción se ejecutó). Los declara el código, el request no puede cambiarlos y siguen las mismas reglas de claves que `bodyFields`. |
| `bodyFields` | Campos del body que se copian a `metadata`. Si se declara un secreto o un dato personal, la aplicación no arranca. |

Con `@Res()` el handler debe enviar la respuesta antes de terminar, para que se registre el status real.

## Contrato del evento

| Campo | Columna | Contenido |
|---|---|---|
| `eventId` | `admin_audit_event_id` | UUID generado por la aplicación. |
| `occurredAt` | `occurred_at` | Momento en que terminó la acción. |
| `actorId` | `actor_user_id` | Usuario autenticado; `NULL` si no hubo actor (sin token). Sin FK: el evento no cambia si el usuario se borra. |
| `actorRole` | `actor_role` | Rol del actor en ese momento. |
| `action` | `action` | Acción del catálogo. |
| `entityType` / `entityId` | `entity_type` / `entity_id` | Entidad afectada. |
| `result` | `result` | `success`; `denied` (toda respuesta 401/403: sin token, sin rol, contraseña pendiente de cambio o regla de autorización de la acción); `failed` (cualquier otro error). |
| `statusCode` | `status_code` | Status HTTP que recibió el cliente. |
| `correlationId` | `correlation_id` | Cabecera `X-Request-Id`: la del cliente si es válida (8 a 64 caracteres `A-Z a-z 0-9 . _ : -`), si no un UUID nuevo. Se devuelve en la respuesta y está expuesta por CORS. |
| `ip` | `ip_address` | `req.ip`: solo confía en `X-Forwarded-For` de los proxies declarados en `TRUST_PROXY`. |
| `metadata` | `metadata` | Solo los `bodyFields` declarados, escalares, hasta 200 caracteres. |

## Quién registra qué

| Momento | Dónde | Resultado |
|---|---|---|
| Sin token válido | `JwtAuthGuard` | `denied`, 401, sin actor |
| Contraseña pendiente de cambio | `PasswordChangeGuard` | `denied`, 403 |
| Rol no permitido | `RolesGuard` | `denied`, 403 |
| El handler termina bien o con error | `AdminAuditInterceptor` | `success`, o `denied`/`failed` según el status |

Los guards corren antes que los interceptores, por eso registran ellos mismos. Los 429 del limitador no se registran: no son una decisión de autorización. `ThrottlerGuard` es el primer guard global, así que los rechazos también consumen el límite por IP y nadie puede llenar la tabla en bucle sin token.

## Datos que nunca se guardan

Además de la lista `bodyFields`, cada clave se parte en palabras (`newPassword` → new, password; `api_key` → api, key) y se descarta si es una credencial (`password`, `pass`, `pwd`, `pin`, `token`, `jwt`, `secret`, `signature`, `otp`, `totp`, `authorization`, `cookie`, `hash`, `credential`, `apiKey`, `accessKey`, `privateKey`, `clientSecret`, códigos de verificación o de un solo uso) o un dato personal (`email`, `phone`, `address`, `contact`, `recipient`, `document`, nombres). Los códigos de catálogo (`zoneCode`, `reasonCode`) se conservan.

## Política de fallo

Registrar nunca cambia la respuesta ni lanza. Si no se puede guardar el evento, se loguea un ERROR `admin_audit_write_failed` con el evento completo (sin secretos), para que el hueco sea visible y recuperable.

## Catálogo de acciones sensibles

| Acción | Entidad | Endpoints |
|---|---|---|
| `user.created` | user | POST /users, POST /auth/register |
| `user.updated` | user | PUT /users/:id |
| `user.role_changed` | user | PATCH /users/:id/role (instrumentado) |
| `user.deleted` | user | DELETE /users/:id |
| `auth.two_factor_changed` | user | POST /auth/2fa/enable, /auth/2fa/confirm, /auth/2fa/disable |
| `auth.password_changed` | user | PATCH /auth/change-password |
| `setting.updated` | setting | PUT /settings/:key, PUT /settings/alert-thresholds |
| `catalog.changed` | catalog | POST/PUT/DELETE de zonas de reparto, motivos de incidencia y de reprogramación, niveles de servicio y tipos de incidente vehicular |
| `vehicle.changed` | vehicle | POST /vehicles, PUT /vehicles/:id, PATCH /vehicles/:id/status, DELETE /vehicles/:id |
| `tracking_link.revealed` | dispatch | POST /dispatches/change-requests/:id/tracking-link |
| `planning.run` | planning | POST /planning/generate, POST /planning/cutoff |
| `route_batch.approved` | route_batch | POST /route-batches/:id/approve-promises, POST /route-batches/:id/approve-final |
| `route_batch.assignment_changed` | route_batch | PATCH /route-batches/:id/driver, /vehicle, /reviewer; POST /route-batches/:id/reassign |
| `dispatch.cancelled` | dispatch | POST /dispatches/:id/cancel, PATCH /pickup-orders/:id/cancel |
| `dispatch.rescheduled` | dispatch | POST /dispatches/:id/reschedule, POST /dispatches/:id/return, PATCH /dispatches/:id/priority |

Fuera del catálogo: los endpoints operativos del repartidor (estado, incidencias, evidencias, GPS) y los públicos del cliente; su traza es el historial del despacho (`dispatch_events`).
