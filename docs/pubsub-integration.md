# Integración con Google Cloud Pub/Sub

## Consumir un topic real

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

## Publicar en Grupo H y procesar una copia local

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
