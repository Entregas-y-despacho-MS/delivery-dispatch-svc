# Delivery OTP — ST-31.4

`DispatchOtpModule` consumes the post-commit `dispatch.status_changed` event and rereads the dispatch.
Only a committed transition to `in_transit` with `high_value_control` issues the initial code,
once per dispatch. Repeated events and reentry never generate another initial issue; replacements
require an explicit controlled resend. The source system guarantees verification of
`contact_phone` (user decision, 2026-10-18); absence or unusable format records
`dispatch_events.otp_resolution_required` for Dispatch intervention and preserves the evidence policy.
Numbers must contain 7–15 international digits, optionally preceded by `+`.

Settings `otp_code_length` (default 6, supported 4–10) and `otp_expiry_minutes` (default 60,
supported 1–1440) control generation and Redis TTL. Invalid values use the defaults. Digits use
`node:crypto.randomInt`, hashes use bcrypt with random salt. Only the hash is stored. The clear
code is never returned through HTTP or stored in the OTP database/cache as plaintext. `SmsSender`
is the replaceable transport port. By default, its simulated implementation records a structured
`sms.sent` event with redacted content and no recipient. Replace the adapter for real SMS.

The explicit local debugging exception requires **both** `NODE_ENV=development` and
`SMS_SIMULATED_LOG_BODY=true`. The validated flag defaults to `false` (including `.env.example`).
Only then does the simulator log the message body and a masked phone with its last four characters;
it never logs the complete phone. Treat those opt-in logs as sensitive because they contain the OTP.
Keep the flag false in shared development and deployment configuration; production, test, debug and
other environments ignore it even when true. There is no body logging opt-in for a real SMS provider.

Redis uses existing `REDIS_HOST`/`REDIS_PORT`, dependency and configuration. A dedicated adapter is
necessary because the generic `CacheService` cannot express multi-key atomic OTP transitions.
Keys `dispatch-otp:{ID}:code` and `dispatch-otp:{ID}:limits` share a cluster slot. Lua serializes issue,
resend, failure increments, lockout and consumption. The code key expires; the limits hash stores
`failures`, `resends`, `consumed` and deliberately has no TTL, so expiry cannot bypass limits.
Duplicate initial events never replace an issued code, including after expiry. A controlled resend
replaces the hash, restarts TTL, preserves failures and is allowed at most twice. Three incorrect
verdicts burn the code. Successful verification consumes it exactly once. A compare against a
replaced generation returns `replaced` without consuming or incrementing attempts.

`POST /dispatches/:id/otp/resend` requires DRIVER (existing ROOT bypass still checks assignment),
current assignment and applicable policy/status. It returns only acceptance and expiry. Redis down
fails closed with 503. SMS failure conditionally invalidates that generation, retains the counters
and permits only a bounded controlled resend; it cannot restore an earlier code. Initial Redis
failure leaves no code; the resend endpoint can retry initial issuance after Redis recovery.
A process crash between Redis issue and simulated send can require a controlled resend. A database failure after SMS acceptance can return an error while the sent code remains active;
the listener attempts an operational resolution mark. Redis/SMS/PostgreSQL are not one transaction. Local
EventEmitter is not durable; no delivery guarantee or transactional outbox is introduced here.
Concurrent resends can deliver messages out of order, but only the latest Redis generation can verify.

`DispatchOtpService.verify` is an internal seam for ST-31.3. It does not register evidence or expose
an endpoint. Its consumer must enforce current policy/status/ownership and only record successful
OTP evidence. Hash comparison happens outside Redis; the atomic final verdict compares the observed
hash again, rejecting stale comparisons and concurrent reuse. No plaintext goes into Lua arguments.

Operational cleanup: retain the limits keys for as long as a dispatch could be reopened or replayed.
An explicit, separately designed archival job may delete both keys only when the dispatch is
permanently archived. There is no timer or automatic reset in this change.

Run `npx vitest run src/app/dispatch-otp src/plugins/sms`. Atomic integration tests require an explicitly
provided **disposable** Redis via `OTP_TEST_REDIS_PORT`; otherwise they are skipped. They delete only
their random dispatch keys. No shared cache instance is inferred.

## Decisiones de revisión del PR

- **C1 — SMS simulado:** se conserva la redacción total del contenido y del destinatario en
  todos los entornos por defecto. La revisión posterior solicitó una excepción explícita para
  depuración local: únicamente `NODE_ENV=development` junto con `SMS_SIMULATED_LOG_BODY=true`
  habilita el cuerpo en el registro estructurado del simulador, con teléfono enmascarado. Esta
  excepción sustituye la decisión anterior de redacción incondicional en desarrollo. En producción,
  test, debug y entornos compartidos se mantiene la configuración deshabilitada; fuera de development
  el adaptador ignora el flag. Los tests no escriben OTP reales en logs: interceptan Logger en memoria.
- **C2 — integración pendiente:** se mantiene el rechazo de OTP arbitrario por el flujo legacy y el
  requisito de evidencia OTP para entregar despachos `high_value_control`. ST-31.4 no implementa
  ST-31.3: generar/enviar códigos no crea evidencia. Por tanto, un despacho de alto valor no puede
  completar ese flujo sin el validador y su integración móvil. El usuario confirmó coordinar el
  despliegue conjunto de ST-31.3 y móvil; esa coordinación no acredita su implementación ni pruebas.
  El contrato actual de sync expone `outcome: 'failed'` y un mensaje `error`, sin código de excepción
  estructurado por resultado. Móvil debe presentar ese resultado de negocio y evitar reintentarlo
  indefinidamente con OTP arbitrarios o evidencia insuficiente.
- **C3 — formato del teléfono:** antes de validar y enviar solo se eliminan espacios ASCII y guiones
  (`-`); se conserva `+`. Paréntesis, puntos, tabuladores, letras y demás caracteres se rechazan.
  La normalización no verifica el teléfono: la verificación sigue siendo garantía del origen.
- **C4 — resolución pendiente:** `otp_resolution_required` se deduplica por episodio mediante una
  transacción y bloqueo `FOR UPDATE` de la fila del despacho. Todas las escrituras de eventos de
  este módulo, incluidos `otp_sent` y `otp_resent`, usan ese mismo bloqueo. Solo se agrega un marker
  si no existe otro posterior al último envío exitoso, comparando `dispatch_event_id` de servidor.
  Se conserva el primer motivo del episodio aunque después ocurra otro error. Un envío exitoso
  cierra el episodio implícitamente; una falta posterior permite un nuevo marker. No se actualizan
  eventos históricos ni se modifica el esquema. No se adquiere un bloqueo de ruta tras el despacho.
  La marca es persistencia operativa: no se localizó un consumidor en el código backend
  inspeccionado que la exponga a Despacho; las interfaces externas no se validaron. Las dependencias y una consulta de diagnóstico figuran en [PENDIENTES](../../../PENDIENTES.md).
- **C5 — fallo SMS:** intentar un reenvío consume irrevocablemente una de las dos cuotas, incluso si
  el adaptador falla. Se invalida únicamente esa generación y no se devuelve cuota ni se restaura
  el código previo. Es una decisión intencional para mantener los límites bajo fallos/concurrencia;
  la UI debe mostrar `OTP_SEND_FAILED` y no hacer reintentos automáticos ilimitados. Un fallo del
  primer envío consume su emisión inicial; solo quedan los dos reenvíos controlados.
- **C6 — reentrada en tránsito:** salir y volver a `in_transit` no reinicia emisión, fallos ni cuotas,
  incluso si el código expiró. Una nueva notificación inicial es idempotente durante toda la vida
  del despacho. La recuperación sigue siendo el reenvío explícito, con un máximo de dos; no existe
  un reinicio implícito por estado, expiración ni cambio de fecha.


## SMS de entrega y correo son flujos distintos

La fuente arquitectónica es `delivery-dispatch-docs/especificacion-sistema.md`, sección **2.b.
Integración con Sistemas Externos** (línea 126) y sección **4. Pila Tecnológica del Microservicio**
(filas Backend y Notificaciones, líneas 342 y 348 en la versión sincronizada `e1a96d5`). Allí figuran
Correo / Push / SMS como integración externa: correo para notificaciones al cliente, push al repartidor
y SMS para el OTP de entrega, mediante adaptador simulado durante el proyecto. Esta referencia
corresponde al repositorio hermano de documentación del workspace, no a una dependencia ejecutable.
El código por correo de reprogramación en `app/public-tracking` pertenece a otro flujo y no reemplaza
el SMS de entrega de alto valor.

El mensaje de entrega conserva el código y la vigencia configurable e indica: «Dáselo al repartidor
solo al recibir tu pedido». Ni el mensaje ni esta simulación acreditan que ST-31.3 o su integración
móvil estén implementados; siguen aplicando los pendientes y la coordinación de despliegue anteriores.
