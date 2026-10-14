# Primera aprobación de promesas

`POST /route-batches/:id/approve-promises` recibe la versión actual del lote, la versión de cada
despacho y, opcionalmente, los despachos que el coordinador retira. Debe incluir todas las filas
del lote. La operación bloquea lote y despachos, comprueba que el lote siga provisional, verifica
el revisor y la capacidad, y confirma todo en una transacción.

Los despachos aprobados pasan a `scheduled`, reciben un `tracking_token` y aumentan su versión. El
lote también aumenta su versión. Los despachos retirados vuelven a `pending`, se separan del lote y
se auditan. El correo se intenta después del commit para no enviar una promesa de una transacción
que haya fallado.

`promise_notified_at` se fija solo cuando el transporte acepta el correo. Un rebote no inicia la
ventana de respuesta: queda registrado como `promise_email_bounced` y `contact_management_required`
en las bitácoras append-only para que el coordinador contacte al cliente. Un destinatario vacío se
omite y la respuesta indica `skipped`.

El token sigue la decisión D-18: permanece vigente mientras el despacho esté abierto. Por eso
`tracking_token_expires_at` queda `NULL` al aprobar; el vencimiento se fija al cerrar el despacho,
para conservar el enlace 30 días después del cierre.

Una versión desactualizada responde 409. Si la asignación, las ventanas o el estado cambian mientras
se revisa, el cliente debe volver a cargar el lote y aprobar la versión vigente.
