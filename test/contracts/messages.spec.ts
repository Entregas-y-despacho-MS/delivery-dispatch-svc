import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

/**
 * Contratos de mensajería (ST-76.1): un esquema y un ejemplo por tópico del
 * catálogo de docs/interoperabilidad-y-flujos.md §1.4.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CONTRACTS = resolve(ROOT, 'contracts/messages');
const SCHEMAS_DIR = resolve(CONTRACTS, 'schemas');
const EXAMPLES_DIR = resolve(CONTRACTS, 'examples');
const DOC_PATH = resolve(
  ROOT,
  '../../docs/delivery-dispatch-docs/interoperabilidad-y-flujos.md',
);

const Ajv2020 = (Ajv2020Module as any).default ?? Ajv2020Module;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const topicsIn = (dir: string, suffix: string): string[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .map((file) => file.slice(0, -suffix.length))
    .sort();

const schemaTopics = topicsIn(SCHEMAS_DIR, '.schema.json');
const exampleTopics = topicsIn(EXAMPLES_DIR, '.example.json');

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const envelope = readJson(resolve(CONTRACTS, 'envelope.schema.json'));
ajv.addSchema(envelope);
for (const topic of schemaTopics) {
  ajv.addSchema(readJson(resolve(SCHEMAS_DIR, `${topic}.schema.json`)));
}

const example = (topic: string) =>
  readJson(resolve(EXAMPLES_DIR, `${topic}.example.json`));
const validate = (topic: string, message: unknown): boolean => {
  const schema = readJson(resolve(SCHEMAS_DIR, `${topic}.schema.json`));
  return ajv.getSchema(schema.$id)!(message) as boolean;
};
const mutated = (topic: string, change: (message: any) => void) => {
  const message = structuredClone(example(topic));
  change(message);
  return message;
};

/** Tópicos listados en las tablas de la sección 1.4 del documento. */
const catalogTopics = (): string[] => {
  const text = readFileSync(DOC_PATH, 'utf8');
  const start = text.indexOf('### 1.4.');
  const end = text.indexOf('### 1.5.');
  const section = text.slice(start, end);
  const topics = [...section.matchAll(/^\| `([a-z_]+\.[a-z_]+\.[a-z_]+)` \|/gm)]
    .map((match) => match[1])
    .sort();
  return topics;
};

describe('contratos de mensajes: carpeta contracts/messages', () => {
  it('tiene un esquema y un ejemplo por tópico, sin archivos huérfanos', () => {
    expect(schemaTopics.length).toBeGreaterThan(0);
    expect(exampleTopics).toEqual(schemaTopics);
  });

  describe.each(schemaTopics)('%s', (topic) => {
    const schema = readJson(resolve(SCHEMAS_DIR, `${topic}.schema.json`));

    it('fija type, source y schemaVersion del sobre', () => {
      expect(schema.properties.type.const).toBe(topic);
      expect(schema.properties.source.const).toEqual(expect.any(String));
      expect(schema.properties.schemaVersion.const).toEqual(expect.any(Number));
    });

    it('prohíbe campos no declarados en data', () => {
      const data = schema.$defs.data;
      expect(data.additionalProperties).toBe(false);
    });

    it('su ejemplo es un mensaje válido de ese tópico', () => {
      const message = example(topic);
      expect(message.type).toBe(topic);
      const schemaFn = ajv.getSchema(schema.$id)!;
      const ok = schemaFn(message);
      expect(schemaFn.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });
  });
});

describe.skipIf(!existsSync(DOC_PATH))(
  'contratos de mensajes: sincronía con el catálogo del documento',
  () => {
    it('cada tópico del catálogo 1.4 tiene esquema y ejemplo, y viceversa', () => {
      const catalog = catalogTopics();
      expect(catalog.length).toBeGreaterThan(0);
      expect(schemaTopics).toEqual(catalog);
      expect(exampleTopics).toEqual(catalog);
    });
  },
);

describe('contratos de mensajes: reglas de negocio', () => {
  it('marketplace.sales_order.confirmed exige confirmedAt', () => {
    const message = mutated('marketplace.sales_order.confirmed', (m) => {
      delete m.data.confirmedAt;
    });
    expect(validate('marketplace.sales_order.confirmed', message)).toBe(false);
  });

  it('marketplace.sales_order.confirmed no admite datos de pago', () => {
    const message = mutated('marketplace.sales_order.confirmed', (m) => {
      m.data.paymentMethod = 'card';
    });
    expect(validate('marketplace.sales_order.confirmed', message)).toBe(false);
  });

  it('marketplace.sales_order.confirmed acepta una dirección sin coordenadas', () => {
    const message = mutated('marketplace.sales_order.confirmed', (m) => {
      delete m.data.deliveryAddress.location;
    });
    expect(validate('marketplace.sales_order.confirmed', message)).toBe(true);
  });

  it('rechaza fechas que no están en UTC', () => {
    const message = mutated('marketplace.sales_order.confirmed', (m) => {
      m.occurredAt = '2026-10-07T09:40:00-04:00';
    });
    expect(validate('marketplace.sales_order.confirmed', message)).toBe(false);
  });

  it('rechaza un messageId que no es UUID v7', () => {
    const message = mutated('inventory.shipment.ready', (m) => {
      m.messageId = '0192f1e2-7c3a-4b41-9a1e-5d2f0c8e4a10';
    });
    expect(validate('inventory.shipment.ready', message)).toBe(false);
  });

  it('inventory.shipment.ready acepta physicallyPacked ausente', () => {
    const message = mutated('inventory.shipment.ready', (m) => {
      delete m.data.physicallyPacked;
    });
    expect(validate('inventory.shipment.ready', message)).toBe(true);
  });

  it('inventory.shipment.ready rechaza physicallyPacked no booleano', () => {
    const message = mutated('inventory.shipment.ready', (m) => {
      m.data.physicallyPacked = 'si';
    });
    expect(validate('inventory.shipment.ready', message)).toBe(false);
  });

  it('inventory.shipment.ready rechaza evidencePolicy fuera del enum', () => {
    const message = mutated('inventory.shipment.ready', (m) => {
      m.data.evidencePolicy = 'firma_simple';
    });
    expect(validate('inventory.shipment.ready', message)).toBe(false);
  });

  it.each(['hand_delivery_standard', 'contactless_delivery', 'high_value_control'])(
    'inventory.shipment.ready acepta evidencePolicy %s',
    (policy) => {
      const message = mutated('inventory.shipment.ready', (m) => {
        m.data.evidencePolicy = policy;
      });
      expect(validate('inventory.shipment.ready', message)).toBe(true);
    },
  );

  it('inventory.shipment.ready rechaza bultos vacíos o con peso no positivo', () => {
    const empty = mutated('inventory.shipment.ready', (m) => {
      m.data.packages = [];
    });
    const zeroWeight = mutated('inventory.shipment.ready', (m) => {
      m.data.packages[0].grossWeightKg = 0;
    });
    expect(validate('inventory.shipment.ready', empty)).toBe(false);
    expect(validate('inventory.shipment.ready', zeroWeight)).toBe(false);
  });

  it('rechaza un source que no corresponde al tópico', () => {
    const message = mutated('inventory.shipment.ready', (m) => {
      m.source = 'marketplace';
    });
    expect(validate('inventory.shipment.ready', message)).toBe(false);
  });

  it('procurement.pickup.requested acepta la solicitud sin dirección, destino ni horario', () => {
    const message = mutated('procurement.pickup.requested', (m) => {
      delete m.data.pickupAddress;
      delete m.data.warehouseId;
      delete m.data.pickupWindow;
    });
    expect(validate('procurement.pickup.requested', message)).toBe(true);
  });

  it('procurement pickup accepts open-ended transport condition labels', () => {
    const requested = mutated('procurement.pickup.requested', (m) => {
      m.data.transportConditions = ['fragilidad', 'temperatura controlada'];
    });
    const updated = mutated('procurement.pickup.updated', (m) => {
      m.data.transportConditions = ['mantener seco'];
    });
    expect(validate('procurement.pickup.requested', requested)).toBe(true);
    expect(validate('procurement.pickup.updated', updated)).toBe(true);
  });

  it.each([
    'marketplace.sales_order.updated',
    'procurement.pickup.updated',
  ])('%s rechaza un cambio sin ningún campo modificado', (topic) => {
    const message = mutated(topic, (m) => {
      const { recordVersion, updatedAt } = m.data;
      const idKey = topic.startsWith('marketplace') ? 'salesOrderId' : 'purchaseOrderId';
      m.data = { [idKey]: m.data[idKey], recordVersion, updatedAt };
    });
    expect(validate(topic, message)).toBe(false);
  });

  it('dispatch.shipment.prepare_requested exige recordVersion y fecha de salida ISO', () => {
    const noVersion = mutated('dispatch.shipment.prepare_requested', (m) => {
      delete m.data.recordVersion;
    });
    const badDate = mutated('dispatch.shipment.prepare_requested', (m) => {
      m.data.departureDate = '09/10/2026';
    });
    expect(validate('dispatch.shipment.prepare_requested', noVersion)).toBe(false);
    expect(validate('dispatch.shipment.prepare_requested', badDate)).toBe(false);
  });

  describe('dispatch.transfer.status_changed', () => {
    const topic = 'dispatch.transfer.status_changed';

    it('no admite datos personales ni tracking_token', () => {
      const personal = mutated(topic, (m) => {
        m.data.recipientName = 'María Fernández';
      });
      const token = mutated(topic, (m) => {
        m.data.tracking_token = 'abc123';
      });
      expect(validate(topic, personal)).toBe(false);
      expect(validate(topic, token)).toBe(false);
    });

    it('acepta el mensaje sin reasonCode', () => {
      const message = mutated(topic, (m) => {
        delete m.data.reasonCode;
      });
      expect(validate(topic, message)).toBe(true);
    });

    it.each(['delivered', 'not_delivered', 'incident', 'returned', 'cancelled'])(
      'acepta el estado de resultado %s',
      (status) => {
        const message = mutated(topic, (m) => {
          m.data.status = status;
        });
        expect(validate(topic, message)).toBe(true);
      },
    );

    it('rechaza un estado que no se informa al ERP', () => {
      const message = mutated(topic, (m) => {
        m.data.status = 'in_transit';
      });
      expect(validate(topic, message)).toBe(false);
    });

    it('exige exactamente uno entre salesOrderId y purchaseOrderId', () => {
      const both = mutated(topic, (m) => {
        m.data.purchaseOrderId = 'PO-2026-000087';
      });
      const none = mutated(topic, (m) => {
        delete m.data.salesOrderId;
      });
      const purchase = mutated(topic, (m) => {
        delete m.data.salesOrderId;
        m.data.purchaseOrderId = 'PO-2026-000087';
      });
      expect(validate(topic, both)).toBe(false);
      expect(validate(topic, none)).toBe(false);
      expect(validate(topic, purchase)).toBe(true);
    });

    it('rechaza un trackingCode con formato inválido', () => {
      const message = mutated(topic, (m) => {
        m.data.trackingCode = 'DSP-26-1';
      });
      expect(validate(topic, message)).toBe(false);
    });
  });

  it('dispatch.sync.requested limita los intentos a 3', () => {
    const fourth = mutated('dispatch.sync.requested', (m) => {
      m.data.attempt = 4;
    });
    expect(validate('dispatch.sync.requested', fourth)).toBe(false);
  });
});
