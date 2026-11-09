# Roles y matriz de permisos

Hay cinco roles paralelos: `ROOT`, `ADMIN`, `COORDINATOR`, `SUPERVISOR` y `DRIVER`. Ninguno implica los
permisos de otro: cada endpoint declara su lista con `@Roles(...)` (o un atajo como `@CoordinatorOnly()`).
`ROOT` es el único especial: salta toda comprobación y es una cuenta de emergencia, no de uso diario. Una ruta
sin decorador de rol admite a cualquier usuario autenticado, y las marcadas `@Public()` no piden token.

La matriz sale de los `@Roles` de los controladores y la verifica
`test/supervisor-permissions.e2e-spec.ts` con un token real de Supervisor (200 en lo permitido, 403 en lo
reservado). Debe coincidir con `PORTAL_ROUTES` del portal web (`config/portal-routes.ts`).

## Qué puede hacer el Supervisor

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
| Recojos | `GET /pickup-orders` | Sí (solo lectura, también el Coordinador) |
| Recojos | `POST /pickup-orders`, `PATCH /pickup-orders/:id/cancel` | **No**, solo Coordinador |
| Flota | `/vehicles` (CRUD), `GET`, `POST` y `PATCH :id/status` de `/vehicle-maintenances`, `/vehicle-incident-types` (`GET`, `POST`, `PUT`) | Sí |
| Flota | `GET /fleet/kpis?period=today\|week\|month` | Sí (también el Coordinador; el Repartidor recibe 403) |
| Flota | `GET /fleet/live-positions`, `PATCH /vehicles/:id/status` | Sí (también el Coordinador) |
| Lotes de ruta | `GET :id/reassignment-targets` y `POST :id/reassign` | Sí (también el Coordinador) |
| Lotes de ruta | `GET /route-batches/cotejo-exclusions` | Sí (también el Coordinador) |
| Lotes de ruta | `POST /dispatches/:id/cotejo-resolved` | **No**, solo Coordinador |
| Reportes | `GET /reports/sla` | **No**, solo Coordinador |
| Catálogos | `GET /warehouses`, `GET /incident-reasons`, `GET /reschedule-reasons` | Sí (solo lectura) |
| Catálogos | `POST` y `PUT` de `/incident-reasons` y `/reschedule-reasons` | **No**, solo Coordinador |
| Catálogos | `/service-levels`, `/delivery-zones` | **No**, solo Coordinador |
| Ajustes | `GET /settings` (Administrador y Coordinador), `PUT /settings/:key` | **No** |
| Ajustes | `GET /settings/alert-thresholds` | Sí (también el Coordinador) |
| Ajustes | `PUT /settings/alert-thresholds` | Sí, solo Supervisor (y root); el Coordinador recibe 403. Va en su propio endpoint: `/settings` no cambia |
| Auditoría | `GET /audit/outbound-message-alerts` | **No**, solo Coordinador |
| Usuarios | `/users`, `/roles`, `POST /auth/register` | **No**, solo Administrador (el listado de `/users` y `/roles` también lo lee el Coordinador) |
| Repartidor | `my-assignments`, `my-history`, `drivers/me/metrics`, inicio y aceptación de lotes, estados, evidencias, OTP, incidencias, `supplier-pickup`, `return-pickup`, `arrived-at-warehouse`, `tracking/locations`, `push-tokens` | **No**, solo Repartidor |

Cualquier usuario autenticado, incluido el Supervisor, puede usar `POST /auth/logout`,
`PATCH /auth/change-password` y `/auth/2fa/*` sobre su propia cuenta.

Quien agregue un endpoint nuevo del Supervisor añade su fila a la tabla de arriba y su caso a
`test/supervisor-permissions.e2e-spec.ts`.
