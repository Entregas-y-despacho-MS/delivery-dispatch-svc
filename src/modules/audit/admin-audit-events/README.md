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

**Transacción y outbox (ST-68.2).** El evento se escribe después de que el handler terminó, en su propia escritura, no dentro de la transacción del handler, y no usa outbox: una auditoría que se perdiera junto con una operación revertida ocultaría el intento, y una que bloqueara la operación cambiaría su resultado. Por eso la operación nunca falla por la auditoría y el fallo de escritura no es silencioso: queda el ERROR `admin_audit_write_failed` con el evento completo para reconstruir la fila. Un fallo del servidor entre el handler y la escritura es la única ventana sin registro.

## Matriz de cobertura: acción → handler → registro

Cada fila es un handler decorado con `@AuditAction`. El catálogo (`domain/admin-audit-catalog.ts`) lista uno por uno los endpoints de cada acción y `test/admin-audit-coverage.e2e-spec.ts` recorre las rutas de la aplicación real: falla si un endpoint del catálogo no lleva su decorador o si un handler decorado no está en el catálogo. No detecta un handler mutante nuevo que no esté en el catálogo: decidir si es sensible es una decisión de diseño que se toma al añadirlo al catálogo, no algo que la prueba pueda inferir (hoy quedan fuera, por acuerdo, los endpoints del repartidor, los públicos del cliente y otros como el mantenimiento de vehículos, `forgot-password`/`reset-password` o `dispatch-reservations`). La columna «Prueba» es el e2e de `test/` que comprueba el registro (permitido, denegado y fallido).

| Acción | Entidad | Endpoints | Handler | Prueba |
|---|---|---|---|---|
| `user.created` | user | POST /users | `UsersController.create` | `admin-audit-users-auth` |
| `user.created` | user | POST /auth/register | `AuthController.register` | `admin-audit-users-auth` |
| `user.updated` | user | PUT /users/:id | `UsersController.update` | `admin-audit-users-auth` |
| `user.role_changed` | user | PATCH /users/:id/role | `UsersController.updateRole` | `admin-audit-events` |
| `user.deleted` | user | DELETE /users/:id | `UsersController.remove` | `admin-audit-users-auth` |
| `auth.two_factor_changed` | user | POST /auth/2fa/enable, /confirm, /disable | `TwoFactorController.enable, confirm, disable` | `admin-audit-users-auth` |
| `auth.password_changed` | user | PATCH /auth/change-password | `AuthController.changePassword` | `admin-audit-users-auth` |
| `setting.updated` | setting | PUT /settings/:key | `SettingsController.update` | `admin-audit-settings-catalogs` |
| `setting.updated` | setting | PUT /settings/alert-thresholds | `AlertThresholdsController.update` | `admin-audit-settings-catalogs` |
| `catalog.changed` | catalog | POST, PUT, DELETE /delivery-zones | `DeliveryZonesController.create, update, remove` | `admin-audit-settings-catalogs` |
| `catalog.changed` | catalog | POST, PUT /incident-reasons | `IncidentReasonsController.create, update` | `admin-audit-settings-catalogs` |
| `catalog.changed` | catalog | POST, PUT /reschedule-reasons | `RescheduleReasonsController.create, update` | `admin-audit-settings-catalogs` |
| `catalog.changed` | catalog | POST, PUT, DELETE /service-levels | `ServiceLevelsController.create, update, remove` | `admin-audit-settings-catalogs` |
| `catalog.changed` | catalog | POST, PUT /vehicle-incident-types | `VehicleIncidentTypesController.create, update` | `admin-audit-settings-catalogs` |
| `vehicle.changed` | vehicle | POST /vehicles, PUT /vehicles/:id, PATCH /vehicles/:id/status, DELETE /vehicles/:id | `VehiclesController.create, update, changeStatus, remove` | `admin-audit-fleet` |
| `tracking_link.revealed` | dispatch | POST /dispatches/change-requests/:id/tracking-link | `CustomerChangeRequestsController.revealTrackingLink` | `admin-audit-dispatch-decisions` |
| `planning.run` | planning | POST /planning/generate, /planning/cutoff | `PlanningController.generate, cutoff` | `admin-audit-planning-batches` |
| `route_batch.approved` | route_batch | POST /route-batches/:id/approve-promises, /approve-final | `RouteBatchesController.approvePromises, approveFinal` | `admin-audit-planning-batches` |
| `route_batch.assignment_changed` | route_batch | PATCH /route-batches/:id/reviewer; POST /route-batches/:id/reassign | `RouteBatchesController.reassignReviewer, reassign` | `admin-audit-planning-batches` |
| `route_batch.assignment_changed` | route_batch | PATCH /route-batches/:id/driver, /vehicle | `RouteBatchCorrectionController.changeDriver, changeVehicle` | `admin-audit-planning-batches` |
| `dispatch.cancelled` | dispatch | POST /dispatches/:id/cancel | `DispatchRescheduleController.cancel` | `admin-audit-dispatch-decisions` |
| `dispatch.cancelled` | dispatch | PATCH /pickup-orders/:id/cancel | `PickupOrdersController.cancel` | `admin-audit-dispatch-decisions` |
| `dispatch.rescheduled` | dispatch | POST /dispatches/:id/reschedule, /return | `DispatchRescheduleController.reschedule, returnToWarehouse` | `admin-audit-dispatch-decisions` |
| `dispatch.rescheduled` | dispatch | PATCH /dispatches/:id/priority | `DispatchesController.changePriority` | `admin-audit-dispatch-decisions` |
| `audit.exported` | audit | GET /audit/admin-events/export | `AdminAuditEventsController.exportEvents` | `admin-audit-export` |

Qué guarda `metadata` según la acción (valores fijos del código y campos declarados del body; las claves de secretos y datos personales se descartan siempre). Salvedad: `value` de `setting.updated` es el valor que se escribió, texto de hasta 200 caracteres; hoy las claves de `settings` son reglas de negocio, así que una clave futura que guarde un secreto no debe auditarse con `value`:

| Acción | `metadata` |
|---|---|
| `user.created` | `roleId` |
| `user.updated` | `active`. No distingue el reseteo de contraseña por un admin de una edición de datos: `metadata` fija no puede depender del cuerpo |
| `user.role_changed` | `roleId` |
| `auth.two_factor_changed` | `step`: `enable`, `confirm` o `disable` |
| `setting.updated` | `value` (por clave) o los tres umbrales y `setting: alert-thresholds` |
| `catalog.changed` | `catalog` y `operation` (`create`, `update`, `delete`) |
| `vehicle.changed` | `operation` (`create`, `status`, `update`, `delete`) y `status` en el cambio de estado |
| `planning.run` | `task`: `generate` o `cutoff` |
| `audit.exported` | `format`, la ventana (`from`, `to`) y los filtros pedidos (`actorId`, `actorRole`, `action`, `entityType`, `entityId`, `result`, `correlationId`, `order`), tal como llegaron en el query string; sin `entity_id` |
| `route_batch.approved` | `stage`: `promises` o `final` |
| `route_batch.assignment_changed` | `target`: `reviewer`, `driver`, `vehicle` o `stops`, y el id destino (`reviewerUserId`, `driverId`, `vehicleId`, `targetBatchId`) |
| `dispatch.rescheduled` | `operation` (`reschedule`, `return`, `priority`), `reasonCode` o `priority` |

`entity_id` sale del parámetro de la ruta; en las altas (`user.created`, `catalog.changed` create, `vehicle.changed` create) del `id` de la respuesta, y en `auth.*` es el propio usuario. `planning.run` y `PUT /settings/alert-thresholds` no tienen id. Una alta que falla no tiene respuesta, así que su evento queda sin id.

Fuera del catálogo: los endpoints operativos del repartidor (estado, incidencias, evidencias, GPS) y los públicos del cliente; su traza es el historial del despacho (`dispatch_events`).

## Consulta de la auditoría (RF-A37, ST-70.1)

`GET /audit/admin-events` (con el prefijo global `/api`). Solo lectura: el servicio (`AdminAuditQueryService`) nunca escribe en la tabla y la consulta en sí no genera un evento.

**Permiso.** Solo Administrador; root pasa por el guard como siempre. Coordinador, Supervisor y Repartidor reciben 403 `INSUFFICIENT_PERMISSIONS` sin datos, y sin token 401. El repartidor no tiene ninguna ruta de auditoría global.

**Parámetros** (todos en el query string; un parámetro desconocido es 400):

| Parámetro | Regla |
|---|---|
| `from`, `to` | Obligatorios. ISO 8601 con zona explícita (`Z` o `±hh:mm`); sin zona o solo fecha es 400. La ventana es `[from, to)`: incluye `from`, excluye `to`, así dos ventanas seguidas no repiten ni saltan eventos. `from` debe ser anterior a `to` y la ventana no puede pasar de 31 días (`INVALID_AUDIT_RANGE`). Un `+` en el query string se envía como `%2B`. |
| `actorId` | Entero 1..2147483647. |
| `actorRole` | Un valor de `RoleEnum` (`root`, `admin`, `coordinator`, `supervisor`, `driver`): el rol que tenía el actor en ese momento. |
| `action` | Una acción del catálogo de arriba. |
| `entityType` | Un tipo de entidad del catálogo (`user`, `setting`, `catalog`, `vehicle`, `dispatch`, `planning`, `route_batch`, `audit`). |
| `entityId` | Hasta 64 caracteres sin espacios; exige `entityType` (`INVALID_AUDIT_FILTER`). |
| `result` | `success`, `denied` o `failed`. |
| `correlationId` | 8 a 64 caracteres `A-Z a-z 0-9 . _ : -` (el `X-Request-Id` de la solicitud). |
| `page`, `limit` | Los de la paginación común: `page` desde 1, `limit` por defecto 10 y máximo 100 (101 es 400). |
| `order` | `asc` o `desc` (por defecto `desc`), siempre por la hora del evento. |

Los filtros se combinan con AND. Los valores van como parámetros de la consulta, nunca concatenados.

**Orden estable.** `ORDER BY occurred_at <dir>, admin_audit_event_id <dir>`: el id desempata los eventos del mismo instante en la misma dirección, así que recorrer las páginas nunca repite ni se salta filas (probado con tres eventos en el mismo instante).

**Respuesta.** `{ data, meta: { page, limit, total, pages } }`. Cada evento trae `eventId`, `occurredAt` (UTC), `actorId`, `actorRole`, `action`, `entityType`, `entityId`, `result`, `statusCode` y `correlationId`. `ip` y `metadata` se devuelven **solo a root**; el Administrador no los recibe. Una ventana sin eventos es `200` con `data: []` y `total: 0`, distinta de cualquier error.

**Errores.** 400 `VALIDATION_FAILED` (formato), `INVALID_AUDIT_RANGE`, `INVALID_AUDIT_FILTER`; 401 `INVALID_TOKEN`; 403 `INSUFFICIENT_PERMISSIONS`.

**Alcance.** Solo cubre `admin_audit_events` (acciones administrativas sensibles). El historial de un despacho (`order_dispatch_events`) es otra consulta; la exportación de esta misma búsqueda (RF-A38) está en la sección siguiente. Los eventos de acciones que ya no estén en el catálogo no se pueden filtrar por `action` (el filtro valida contra el catálogo vigente).

## Exportación de la auditoría (RF-A38, ST-71.1)

`GET /audit/admin-events/export?format=csv|pdf` (con el prefijo global `/api`). Descarga **exactamente** lo que `GET /audit/admin-events` lista para la misma ventana y los mismos filtros.

**Misma consulta.** `AdminAuditQueryService` arma ventana, filtros y orden en un solo lugar (`filteredQuery`) y lo usan la búsqueda y la exportación: los mismos eventos, en el mismo orden (`occurred_at` y `admin_audit_event_id` en la misma dirección) y con la misma proyección por rol. `page` y `limit` se aceptan y se ignoran: el archivo trae todo el resultado filtrado, no una página.

**Permiso.** Igual que la búsqueda: solo Administrador (y root). Coordinador, Supervisor y Repartidor reciben 403 y no se entrega archivo; sin token, 401. Detalle sensible: el Administrador no recibe `ip` ni `metadata` (ni columnas vacías); solo root recibe las columnas `Dirección IP` y `Campos declarados` (JSON).

**Parámetros.** Los de la búsqueda más `format` (obligatorio, `csv` o `pdf`, sin distinguir mayúsculas).

**Validado antes de generar nada** (400 y ningún archivo): formato, ventana de 31 días como máximo y `entityId` con `entityType` (los mismos `INVALID_AUDIT_RANGE` e `INVALID_AUDIT_FILTER` de la búsqueda) y el **tope de filas**: 10 000 en CSV y 2 000 en PDF (`AUDIT_EXPORT_LIMIT_EXCEEDED`, con el mensaje de cómo seguir: acotar la ventana o agregar filtros). El tope se comprueba leyendo una fila más en la misma consulta, sin un `COUNT` aparte. Un resultado vacío es un archivo válido, con el total en 0.

**CSV.** UTF-8 con BOM, separador coma, saltos CRLF. Primero un bloque de contexto (`Auditoría administrativa`; `Período desde (incluido)`, `Período hasta (excluido)` y `Zona horaria`; un `Filtro: <nombre>` por cada filtro aplicado, siempre con `Filtro: Orden`; `Generado el`; `Total de filas`), una línea en blanco, los encabezados de columna y una fila por evento. Una celda que empieza con `=`, `+`, `-`, `@`, tabulación o retorno de carro se antepone con comilla (también los valores de los filtros) y las comas, comillas y saltos se escapan. Las fechas son `YYYY-MM-DD HH:mm:ss` en hora de Bolivia. Columnas: `Fecha y hora`, `Id del evento`, `Id del actor`, `Rol del actor`, `Acción`, `Tipo de entidad`, `Id de la entidad`, `Resultado` (Exitoso/Denegado/Fallido), `Código HTTP`, `Correlación` (+ las dos de root). Quien procese el CSV por máquina debe saltar el bloque de contexto hasta la línea de encabezados.

**PDF.** A4 horizontal, con el mismo bloque de contexto y las mismas columnas y orden que el CSV (la fila de encabezados se repite en cada página); la acción lleva debajo su descripción del catálogo. Todo valor se escapa como HTML y la página lleva una Content-Security-Policy que bloquea scripts y red.

**Respuesta.** `Content-Disposition: attachment; filename="auditoria-admin-YYYY-MM-DD.<csv|pdf>"` (día de Bolivia) y `Cache-Control: no-store`.

**Auditoría de la exportación.** Cada llamada deja un evento `audit.exported` (entidad `audit`, sin `entity_id`): actor, rol, resultado (`success`, `failed` si el tope o el motor de PDF falló, `denied` si fue 401/403) y en `metadata` el formato, la ventana y los filtros pedidos. La búsqueda sigue sin auditarse.

**Límites conocidos.**
- El escape de fórmulas cambia lo que lee un programa: un valor legítimo que empieza con `-`, `+`, `=` o `@` (p. ej. un `correlationId` como `-abc12345` o un `entityId` que empiece con `-`) sale con una comilla delante. Es el costo de que ninguna hoja de cálculo lo ejecute; al reimportar el CSV hay que quitarla.
- La auditoría de la exportación guarda los valores del query string **como llegaron** (el interceptor corre antes de la validación): `format=PDF` o un `entityId` inválido quedan tal cual, cortados a 200 caracteres, y un parámetro repetido (`?action=a&action=b`) no se registra. Para saber qué se entregó de verdad hay que mirar el `result` y el código HTTP del evento.
- Un PDF abre una página en el único navegador del servicio, sin cola ni límite de PDF simultáneos. Con 2 000 filas y varios administradores exportando a la vez puede subir el uso de memoria; está anotado en `PENDIENTES.md` (un semáforo de 1 o 2 PDF simultáneos si se vuelve un problema).
- Un resultado entre 2 001 y 10 000 filas sale en CSV pero no en PDF (400 `AUDIT_EXPORT_LIMIT_EXCEEDED`). Los eventos que entran entre la búsqueda y la exportación aparecen en el archivo; el `audit.exported` de la propia descarga se escribe después de leer, así que no está en su archivo.

**Errores.** 400 `VALIDATION_FAILED`, `INVALID_AUDIT_RANGE`, `INVALID_AUDIT_FILTER`, `AUDIT_EXPORT_LIMIT_EXCEEDED`; 401 `INVALID_TOKEN`; 403 `INSUFFICIENT_PERMISSIONS`; 500 `PDF_GENERATION_FAILED`.
