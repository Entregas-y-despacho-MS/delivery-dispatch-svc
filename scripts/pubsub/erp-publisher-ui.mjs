import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PubSub } from '@google-cloud/pubsub';
import { v7 as uuidv7 } from 'uuid';

if (process.env.NODE_ENV === 'production') {
    throw new Error('La página publicadora es solo para desarrollo; no se inicia con NODE_ENV=production.');
}

const port = Number(process.env.ERP_PUBLISHER_UI_PORT ?? 8090);
const cloudProjectId = process.env.GROUP_H_GCP_PROJECT_ID;
const cloudTopicName = process.env.GROUP_H_GCP_TOPIC;
const emulatorHost = process.env.LOCAL_PUBSUB_EMULATOR_HOST;
const publishEnabled = process.env.GROUP_H_PUBLISH_ENABLED === 'true';
const missing = [
    ['GROUP_H_GCP_PROJECT_ID', cloudProjectId],
    ['GROUP_H_GCP_TOPIC', cloudTopicName],
    ['LOCAL_PUBSUB_EMULATOR_HOST', emulatorHost],
    ['GOOGLE_APPLICATION_CREDENTIALS', process.env.GOOGLE_APPLICATION_CREDENTIALS],
    ['DB_HOST', process.env.DB_HOST],
    ['DB_PORT', process.env.DB_PORT],
    ['DB_USER', process.env.DB_USER],
    ['DB_PASSWORD', process.env.DB_PASSWORD],
    ['DB_NAME', process.env.DB_NAME],
].filter(([, value]) => !value).map(([name]) => name);

if (!publishEnabled) missing.push('GROUP_H_PUBLISH_ENABLED=true (confirmación explícita para el tópico compartido)');
if (missing.length) throw new Error(`Falta configurar: ${missing.join(', ')}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ERP_PUBLISHER_UI_PORT debe ser un puerto válido.');

// Compose sets PUBSUB_EMULATOR_HOST for the backend. Remove it before constructing the GCP
// publisher, then point the local copy at the emulator explicitly so the two destinations stay separate.
delete process.env.PUBSUB_EMULATOR_HOST;
const cloud = new PubSub({ projectId: cloudProjectId });
const local = new PubSub({ projectId: 'delivery-dispatch-local', apiEndpoint: emulatorHost });
const db = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 5000,
    max: 3,
});

const TYPES = {
    marketplace: { type: 'marketplace.sales_order.confirmed', source: 'marketplace' },
    inventory: { type: 'inventory.shipment.ready', source: 'inventory' },
};

const page = String.raw`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prueba de mensajes · Grupo H</title>
  <style>
    :root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#152a3a;background:#f1f6fa;font-synthesis:none}
    *{box-sizing:border-box}body{margin:0}.wrap{max-width:1120px;margin:0 auto;padding:36px 20px 60px}
    header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}
    h1{font-size:30px;margin:0 0 8px;color:#235b7a}p{line-height:1.5;color:#526979;margin:6px 0}
    .tag{background:#e1f1f8;color:#235b7a;padding:9px 13px;border-radius:999px;font-weight:700;white-space:nowrap}
    .notice{border:1px solid #e9bf75;background:#fff8e8;padding:16px 18px;border-radius:12px;margin:18px 0 24px;color:#744b09}
    .card{background:white;border:1px solid #d7e4ec;border-radius:16px;padding:22px;box-shadow:0 3px 10px #16364b0d;margin-bottom:18px}
    h2{font-size:19px;margin:0 0 6px;color:#234f6b}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}
    label{display:grid;gap:6px;font-weight:650;font-size:14px;color:#334b5b}input,select{font:inherit;color:#172c3a;border:1px solid #c7d8e3;border-radius:9px;padding:11px 12px;min-width:0;background:#fff}
    input:focus,select:focus{outline:3px solid #b8deed;border-color:#468aaa}.wide{grid-column:1/-1}
    .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:17px}button{font:inherit;font-weight:700;border:0;border-radius:9px;padding:12px 17px;cursor:pointer;background:#e58135;color:white}
    button:disabled{opacity:.55;cursor:wait}.secondary{background:#e9f2f7;color:#245875}.confirm{display:flex;align-items:flex-start;gap:10px;font-weight:500;margin-top:14px;color:#684d20}.confirm input{margin:2px 0 0;min-width:auto}
    .status{display:none;margin-top:17px;border-radius:10px;padding:14px;background:#f3f7fa;border:1px solid #dae5ec}.status.show{display:block}.status h3{margin:0 0 8px;font-size:15px}.steps{display:grid;gap:6px;font-size:14px}.ok{color:#087a55}.bad{color:#ad3e2d}.wait{color:#8a6200}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf3f6;padding:10px;border-radius:8px;font-size:12px}
    .small{font-size:12px;color:#697d8b}.order{max-width:420px}.row{display:flex;align-items:end;gap:10px;flex-wrap:wrap}.row button{padding:11px 13px}
    @media(max-width:700px){.wrap{padding:24px 14px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}header{display:block}.tag{display:inline-block;margin-top:12px}.card{padding:17px}}
  </style>
</head>
<body><main class="wrap">
  <header><div><h1>Prueba de pedidos · Grupo H</h1><p>Publica los mensajes de Marketplace y Almacén, y comprueba por separado su llegada al tópico y el procesamiento local.</p></div><span class="tag">Entorno local</span></header>
  <div class="notice"><strong>Publicación real en el tópico compartido.</strong> Al enviar, se publica en Google Cloud y también se copia al emulador local para que el backend de Docker la procese. Usa datos de prueba. La clave de servicio permanece en el servidor.</div>
  <section class="card"><div class="row"><label class="order">ID compartido del pedido<input id="salesOrderId" maxlength="90" required></label><button class="secondary" id="newOrder" type="button">Nuevo ID de pedido</button></div><p class="small">Usa el mismo ID en Marketplace y Almacén. Si envías solo uno, el backend lo registra y espera el mensaje complementario para crear el despacho.</p></section>
  <form class="card" id="marketplace"><h2>1. Marketplace · Pedido confirmado</h2><p>Envía los datos del cliente y de la dirección de entrega.</p>
    <div class="grid">
      <label>Nombre del cliente<input name="name" value="Cliente de prueba" maxlength="150" required></label>
      <label>Teléfono<input name="phone" value="+59170000000" maxlength="30" required></label>
      <label>Correo (opcional)<input name="email" type="email" value="cliente.prueba@example.com" maxlength="150"></label>
      <label>Prioridad<select name="priority"><option value="normal">Normal</option><option value="urgent">Urgente</option></select></label>
      <label class="wide">Dirección<input name="address" value="Av. Arce 2345, La Paz" maxlength="500" required></label>
      <label class="wide">Referencia<input name="reference" value="Dirección de prueba" maxlength="500"></label>
      <label>Latitud<input name="latitude" type="number" step="0.000001" value="-16.5115" required></label>
      <label>Longitud<input name="longitude" type="number" step="0.000001" value="-68.1223" required></label>
    </div>
    <label class="confirm"><input type="checkbox" required><span>Confirmo publicar este pedido de prueba en el tópico real del Grupo H y copiarlo al backend local.</span></label>
    <div class="actions"><button type="submit">Enviar mensaje de Marketplace</button></div><div class="status" aria-live="polite"></div>
  </form>
  <form class="card" id="inventory"><h2>2. Almacén · Bultos listos</h2><p>Envía la preparación y las dimensiones/peso de los bultos del mismo pedido.</p>
    <div class="grid">
      <label>ID del almacén<input name="warehouseId" value="WH-LPZ-01" maxlength="100" required></label>
      <label>Disponible desde<input name="availableFrom" type="datetime-local" required></label>
      <label>Largo (cm)<input name="lengthCm" type="number" min="0.1" step="0.1" value="40" required></label>
      <label>Ancho (cm)<input name="widthCm" type="number" min="0.1" step="0.1" value="30" required></label>
      <label>Alto (cm)<input name="heightCm" type="number" min="0.1" step="0.1" value="25" required></label>
      <label>Peso bruto (kg)<input name="grossWeightKg" type="number" min="0.01" step="0.01" value="6.4" required></label>
      <label>Condición<select name="handlingCondition"><option value="FRAGILE">Frágil</option><option value="NONE">Ninguna</option></select></label>
      <label>Empacado físicamente<select name="physicallyPacked"><option value="true">Sí</option><option value="false">No</option></select></label>
    </div>
    <label class="confirm"><input type="checkbox" required><span>Confirmo publicar este mensaje de Almacén en el tópico real del Grupo H y copiarlo al backend local.</span></label>
    <div class="actions"><button type="submit">Enviar mensaje de Almacén</button></div><div class="status" aria-live="polite"></div>
  </form>
  <p class="small">La confirmación “procesado por backend” consulta el registro de entrada en la base local. Si se procesaron ambos mensajes, también se muestra el despacho creado y su estado de cobertura.</p>
</main>
<script>
  const idInput=document.querySelector('#salesOrderId');
  const makeId=()=>\`SO-WEB-\${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-\${crypto.randomUUID().slice(0,6).toUpperCase()}\`;
  idInput.value=localStorage.getItem('erp-publisher-order')||makeId();
  idInput.addEventListener('input',()=>localStorage.setItem('erp-publisher-order',idInput.value.trim()));
  document.querySelector('#newOrder').addEventListener('click',()=>{idInput.value=makeId();localStorage.setItem('erp-publisher-order',idInput.value);});
  const localDateTime=()=>{const d=new Date(Date.now()+5*60000);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)};
  document.querySelector('[name="availableFrom"]').value=localDateTime();
  const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function show(el,result){el.classList.add('show');const state=(ok,text)=>\`<div class="\${ok?'ok':'bad'}">\${ok?'✓':'✕'} \${esc(text)}</div>\`;let steps='';
    steps+=state(result.cloud?.ok, result.cloud?.ok?\`Google Cloud aceptó el mensaje · broker \${result.cloud.messageId}\`:\`Google Cloud: \${result.cloud?.error||'sin confirmación'}\`);
    steps+=state(result.local?.ok, result.local?.ok?\`Copia aceptada por emulador · \${result.local.topic}\`:\`Emulador local: \${result.local?.error||'sin confirmación'}\`);
    const b=result.backend||{};const backendClass=b.status==='processed'?'ok':b.status==='rejected'?'bad':'wait';
    const backendText=b.status==='processed'?'Backend procesó y registró el mensaje':b.status==='rejected'?\`Backend rechazó el mensaje\${b.error?': '+b.error:''}\`:b.status==='not_sent'?'Backend no lo pudo recibir: no se publicó en el emulador':'Copia enviada; backend todavía no confirma el procesamiento';
    steps+=\`<div class="\${backendClass}">\${b.status==='processed'?'✓':b.status==='rejected'?'✕':'…'} \${esc(backendText)}</div>\`;
    if(result.dispatch){steps+=\`<div class="ok">✓ Despacho #\${esc(result.dispatch.id)} creado · estado: \${esc(result.dispatch.status)} · zona: \${esc(result.dispatch.zoneName||'sin cobertura asignada')}</div>\`}
    else if(b.status==='processed'){steps+='<div class="wait">El mensaje fue procesado. El despacho aparece cuando llega también el mensaje del otro formulario.</div>'}
    if(result.messageId)steps+=\`<div class="small">ID del mensaje: \${esc(result.messageId)} · pedido: \${esc(result.salesOrderId)}</div>\`;
    if(result.error)steps+=\`<div class="bad">\${esc(result.error)}</div>\`;
    el.innerHTML=\`<h3>Resultado del envío</h3><div class="steps">\${steps}</div>\`;
  }
  async function submit(form,event,source){event.preventDefault();if(!form.reportValidity())return;const button=form.querySelector('button[type="submit"]');const status=form.querySelector('.status');button.disabled=true;button.textContent='Enviando…';status.classList.add('show');status.innerHTML='<h3>Enviando y esperando confirmación del backend…</h3>';
    const f=new FormData(form);const data={salesOrderId:idInput.value.trim()};
    if(!data.salesOrderId){status.textContent='Ingresa el ID compartido del pedido.';button.disabled=false;return}
    if(source==='marketplace'){
      const now=new Date().toISOString();data.recordVersion=1;data.updatedAt=now;data.confirmedAt=now;
      data.recipient={name:f.get('name').trim(),phone:f.get('phone').trim()};if(f.get('email').trim())data.recipient.email=f.get('email').trim();
      data.deliveryAddress={line:f.get('address').trim()};if(f.get('reference').trim())data.deliveryAddress.reference=f.get('reference').trim();
      data.deliveryAddress.location={latitude:Number(f.get('latitude')),longitude:Number(f.get('longitude'))};data.priority=f.get('priority');
    }else{
      const now=new Date().toISOString();data.recordVersion=1;data.updatedAt=now;data.warehouseId=f.get('warehouseId').trim();data.availableFrom=new Date(f.get('availableFrom')).toISOString();
      data.packages=[{packageId:\`\${data.salesOrderId}-PKG-1\`,lengthCm:Number(f.get('lengthCm')),widthCm:Number(f.get('widthCm')),heightCm:Number(f.get('heightCm')),grossWeightKg:Number(f.get('grossWeightKg'))}];
      if(f.get('handlingCondition')!=='NONE')data.handlingConditions=[f.get('handlingCondition')];data.evidencePolicy='hand_delivery_standard';data.physicallyPacked=f.get('physicallyPacked')==='true';
    }
    try{const response=await fetch('/api/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,data})});const result=await response.json();show(status,result)}
    catch(error){status.innerHTML=\`<h3 class="bad">No se pudo contactar al publicador: \${esc(error.message)}</h3>\`}
    finally{button.disabled=false;button.textContent=source==='marketplace'?'Enviar mensaje de Marketplace':'Enviar mensaje de Almacén'}
  }
  document.querySelector('#marketplace').addEventListener('submit',e=>void submit(e.currentTarget,e,'marketplace'));
  document.querySelector('#inventory').addEventListener('submit',e=>void submit(e.currentTarget,e,'inventory'));
</script></body></html>`.replaceAll('\\${', '${').replaceAll('\\`', '`');

function sendJson(response, status, payload) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(payload));
}

function messageAttributes(envelope) {
    return {
        messageId: envelope.messageId,
        type: envelope.type,
        source: envelope.source,
        schemaVersion: String(envelope.schemaVersion),
    };
}

async function readBody(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 32_000) throw new Error('El formulario excede el tamaño permitido.');
    }
    return JSON.parse(body || '{}');
}

function requiredText(value, name, max = 500) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
        throw new Error(`${name} es obligatorio y debe tener como máximo ${max} caracteres.`);
    }
    return value.trim();
}

function numberInRange(value, name, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} está fuera del rango permitido.`);
    return parsed;
}

function buildEnvelope(source, rawData) {
    const definition = TYPES[source];
    if (!definition) throw new Error('Selecciona Marketplace o Almacén.');
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) throw new Error('Datos del mensaje inválidos.');
    const salesOrderId = requiredText(rawData.salesOrderId, 'ID del pedido', 90);
    const now = new Date().toISOString();
    let data;
    if (source === 'marketplace') {
        const recipient = {
            name: requiredText(rawData.recipient?.name, 'Nombre del cliente', 150),
            phone: requiredText(rawData.recipient?.phone, 'Teléfono', 30),
        };
        if (rawData.recipient?.email) recipient.email = requiredText(rawData.recipient.email, 'Correo', 150);
        if (recipient.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)) throw new Error('El correo del cliente no es válido.');
        const address = {
            line: requiredText(rawData.deliveryAddress?.line, 'Dirección', 500),
        };
        if (rawData.deliveryAddress?.reference) address.reference = requiredText(rawData.deliveryAddress.reference, 'Referencia', 500);
        address.location = {
            latitude: numberInRange(rawData.deliveryAddress?.location?.latitude, 'Latitud', -90, 90),
            longitude: numberInRange(rawData.deliveryAddress?.location?.longitude, 'Longitud', -180, 180),
        };
        const priority = rawData.priority === 'urgent' ? 'urgent' : 'normal';
        data = { salesOrderId, recordVersion: 1, updatedAt: now, confirmedAt: now, recipient, deliveryAddress: address, priority };
    } else {
        if (!Array.isArray(rawData.packages) || rawData.packages.length !== 1) throw new Error('Ingresa un bulto de prueba.');
        const pkg = rawData.packages[0];
        const warehouseId = requiredText(rawData.warehouseId, 'ID de almacén', 100);
        const item = {
            packageId: `${salesOrderId}-PKG-1`,
            lengthCm: numberInRange(pkg.lengthCm, 'Largo', 0.1, 10_000),
            widthCm: numberInRange(pkg.widthCm, 'Ancho', 0.1, 10_000),
            heightCm: numberInRange(pkg.heightCm, 'Alto', 0.1, 10_000),
            grossWeightKg: numberInRange(pkg.grossWeightKg, 'Peso', 0.01, 100_000),
        };
        const availableFrom = rawData.availableFrom ? new Date(rawData.availableFrom) : new Date();
        if (Number.isNaN(availableFrom.getTime())) throw new Error('La fecha de disponibilidad no es válida.');
        data = {
            salesOrderId, recordVersion: 1, updatedAt: now, warehouseId,
            availableFrom: availableFrom.toISOString(), packages: [item],
            evidencePolicy: 'hand_delivery_standard',
            physicallyPacked: rawData.physicallyPacked === true,
        };
        if (Array.isArray(rawData.handlingConditions) && rawData.handlingConditions.length) {
            data.handlingConditions = rawData.handlingConditions;
        }
    }
    return { messageId: uuidv7(), type: definition.type, schemaVersion: 1, source: definition.source, occurredAt: now, data };
}

async function findBackendReceipt(messageId, salesOrderId) {
    const [receiptResult, dispatchResult] = await Promise.all([
        db.query('SELECT status, type, error_detail FROM inbound_messages WHERE message_id = $1', [messageId]),
        db.query(
            `SELECT d.dispatch_id AS id, s.name AS status, z.name AS zone_name
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               LEFT JOIN delivery_zones z ON z.delivery_zone_id = d.delivery_zone_id
              WHERE d.source_order_ref = $1
              ORDER BY d.dispatch_id DESC LIMIT 1`,
            [salesOrderId],
        ),
    ]);
    const receipt = receiptResult.rows[0];
    return {
        backend: receipt ? { status: receipt.status, type: receipt.type, error: receipt.error_detail ?? undefined } : { status: 'pending' },
        dispatch: dispatchResult.rows[0] ? {
            id: dispatchResult.rows[0].id,
            status: dispatchResult.rows[0].status,
            zoneName: dispatchResult.rows[0].zone_name,
        } : null,
    };
}

async function waitForBackend(messageId, salesOrderId) {
    const deadline = Date.now() + 25_000;
    let state = await findBackendReceipt(messageId, salesOrderId);
    while (state.backend.status === 'pending' && Date.now() < deadline) {
        await delay(500);
        state = await findBackendReceipt(messageId, salesOrderId);
    }
    return state;
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(page);
        return;
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, cloudProjectId, cloudTopicName });
        return;
    }
    if (request.method !== 'POST' || url.pathname !== '/api/publish') {
        sendJson(response, 404, { error: 'Ruta no encontrada.' });
        return;
    }

    let envelope;
    try {
        const body = await readBody(request);
        envelope = buildEnvelope(body.source, body.data);
    } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Formulario inválido.' });
        return;
    }

    const result = {
        messageId: envelope.messageId,
        salesOrderId: envelope.data.salesOrderId,
        cloud: { ok: false },
        local: { ok: false, topic: envelope.type },
        backend: { status: 'not_sent' },
        dispatch: null,
    };
    try {
        const cloudMessageId = await cloud.topic(cloudTopicName).publishMessage({ json: envelope, attributes: messageAttributes(envelope) });
        result.cloud = { ok: true, messageId: cloudMessageId, topic: cloudTopicName };
    } catch (error) {
        result.cloud = { ok: false, error: error instanceof Error ? error.message : 'No se pudo publicar en Google Cloud.' };
        sendJson(response, 502, result);
        return;
    }

    try {
        const localMessageId = await local.topic(envelope.type).publishMessage({ json: envelope, attributes: messageAttributes(envelope) });
        result.local = { ok: true, messageId: localMessageId, topic: envelope.type };
    } catch (error) {
        result.local = { ok: false, topic: envelope.type, error: error instanceof Error ? error.message : 'No se pudo publicar en el emulador local.' };
        result.error = 'Google Cloud aceptó el mensaje, pero no se pudo publicar la copia local. No repitas a ciegas: el tópico compartido ya recibió el evento.';
        sendJson(response, 502, result);
        return;
    }

    try {
        const state = await waitForBackend(envelope.messageId, envelope.data.salesOrderId);
        result.backend = state.backend;
        result.dispatch = state.dispatch;
        sendJson(response, state.backend.status === 'rejected' ? 422 : 200, result);
    } catch {
        result.backend = { status: 'pending' };
        result.error = 'Se publicaron ambos mensajes, pero no se pudo consultar la base local para confirmar el procesamiento.';
        sendJson(response, 200, result);
    }
});

server.listen(port, '0.0.0.0', () => {
    console.log(`ERP Publisher UI disponible en http://localhost:${port}`);
    console.log(`Tópico GCP compartido: ${cloudProjectId}/topics/${cloudTopicName}`);
    console.log(`Copia local hacia el emulador: ${emulatorHost}`);
});

async function shutdown() {
    server.close();
    await Promise.allSettled([cloud.close(), local.close(), db.end()]);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
