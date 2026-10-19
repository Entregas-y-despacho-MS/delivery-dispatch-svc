# Pendientes de integración — ST-31.4

Estos puntos no están implementados por ST-31.4. Deben coordinarse antes de habilitar el recorrido
completo de entrega de alto valor; el usuario confirmó el despliegue conjunto con ST-31.3 y móvil.

1. **ST-31.3 — validación y evidencia OTP.** Integrar el validador con el contrato del almacén y
   `DispatchOtpService.verify`; comprobar estado, política, permisos, expiración, bloqueo y consumo
   único, y registrar evidencia solo tras una validación exitosa. La generación no acredita entrega.
   Mantener el rechazo legacy de OTP arbitrarios y el gate de evidencia requerida. Sin este punto
   un despacho `high_value_control` no puede completar la entrega por este recorrido.
2. **Móvil — flujo y errores.** Incorporar captura/validación y reenvío explícito. Mostrar errores
   finales de negocio: sync devuelve `outcome: 'failed'` y un mensaje `error`, sin código estructurado
   de excepción por resultado. No reintentar indefinidamente OTP arbitrario,
   falta de evidencia, bloqueo, cuota agotada ni `OTP_SEND_FAILED`. Un fallo SMS consume cuota y no
   restaura códigos previos. Las pruebas de ST-31.4 no acreditan que esta UI ya exista.
3. **Despacho — resolución visible.** Crear el consumidor operativo (vista, endpoint o notificación
   autorizada) de `dispatch_events.otp_resolution_required`. Hoy existe la marca persistente y
   deduplicada, pero no se localizó un consumidor en el código backend inspeccionado que la exponga
   a Despacho. Las interfaces externas móvil/web no están en este repositorio y no se validaron.
   Quedan por definir la exposición, su consumo y la UX operativa. No se añade aquí UI, endpoint ni socket. Un episodio conserva su primer motivo; `otp_sent`/`otp_resent` posterior
   lo cierra implícitamente. Si reaparece la falta tras el éxito, se abre otro episodio.
4. **Operación — archivo y entrega durable.** Definir limpieza de límites Redis solo al archivo
   definitivo del despacho y, si se requieren garantías de entrega, un mecanismo durable para el
   evento local. No borrar contadores por expiración o reentrada en tránsito.

Consulta operativa de solo lectura para identificar marcas actualmente pendientes sin revelar
contactos ni contenido SMS (ordenada por identificadores de eventos del servidor):

```sql
WITH lifecycle AS (
    SELECT dispatch_id,
           MAX(dispatch_event_id) FILTER (WHERE event_type = 'otp_resolution_required') AS pending_id,
           COALESCE(MAX(dispatch_event_id) FILTER (WHERE event_type IN ('otp_sent', 'otp_resent')), 0) AS sent_id
    FROM dispatch_events
    WHERE event_type IN ('otp_resolution_required', 'otp_sent', 'otp_resent')
    GROUP BY dispatch_id
)
SELECT e.dispatch_id, e.dispatch_event_id, e.created_at, e.metadata ->> 'reason' AS reason
FROM lifecycle l
JOIN dispatch_events e ON e.dispatch_event_id = l.pending_id
WHERE l.pending_id > l.sent_id
ORDER BY e.dispatch_event_id;
```
