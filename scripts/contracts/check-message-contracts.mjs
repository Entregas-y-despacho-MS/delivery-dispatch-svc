import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const ROOT = resolve(import.meta.dirname, '../..');
const CONTRACTS = resolve(ROOT, 'contracts/messages');
const SCHEMAS_DIR = resolve(CONTRACTS, 'schemas');
const EXAMPLES_DIR = resolve(CONTRACTS, 'examples');
const INVALID_EXAMPLES_DIR = resolve(EXAMPLES_DIR, 'invalid');
const FIXTURES_DIR = resolve(ROOT, 'test/simulator/fixtures');

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const jsonFiles = (directory, suffix) =>
  readdirSync(directory)
    .filter((file) => file.endsWith(suffix))
    .sort();

const topicNames = (directory, suffix) =>
  jsonFiles(directory, suffix).map((file) => file.slice(0, -suffix.length));

// El catálogo es la sección «Mapa tópico → archivos» del README de contracts/messages: vive en este
// mismo repositorio, así que no depende de ningún otro checkout.
const CATALOG_PATH = resolve(CONTRACTS, 'README.md');
const CATALOG_SECTION = '## Mapa tópico → archivos';

const catalogTopics = (path) => {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf(CATALOG_SECTION);
  if (start < 0) {
    throw new Error(`No se encontró la sección «${CATALOG_SECTION.slice(3)}» en ${path}`);
  }
  const next = text.indexOf('\n## ', start + CATALOG_SECTION.length);
  const section = text.slice(start, next < 0 ? undefined : next);

  return [...section.matchAll(/^\| `([a-z_]+\.[a-z_]+\.[a-z_]+)` \|/gm)]
    .map((match) => match[1])
    .sort();
};

const describeAjvErrors = (errors) =>
  (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
    .join('; ');

const reportDifference = (label, expected, actual) => {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((entry) => !actualSet.has(entry));
  const extra = actual.filter((entry) => !expectedSet.has(entry));
  if (missing.length === 0 && extra.length === 0) return [];

  const details = [
    missing.length ? `faltan: ${missing.join(', ')}` : '',
    extra.length ? `sobran: ${extra.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return [`${label}: ${details}`];
};

const checkContracts = () => {
  const errors = [];
  let checked = 0;
  const schemaTopics = topicNames(SCHEMAS_DIR, '.schema.json');
  const exampleTopics = topicNames(EXAMPLES_DIR, '.example.json');
  const catalog = catalogTopics(CATALOG_PATH);

  if (schemaTopics.length === 0) errors.push(`No hay esquemas en ${SCHEMAS_DIR}`);
  errors.push(...reportDifference('Esquemas y ejemplos', schemaTopics, exampleTopics));
  errors.push(...reportDifference('Catálogo y esquemas', catalog, schemaTopics));

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  try {
    ajv.addSchema(readJson(resolve(CONTRACTS, 'envelope.schema.json')));
    for (const topic of schemaTopics) {
      const path = resolve(SCHEMAS_DIR, `${topic}.schema.json`);
      const schema = readJson(path);
      if (!schema.properties?.schemaVersion) {
        errors.push(`${path}: falta properties.schemaVersion`);
      } else if (
        !Number.isInteger(schema.properties.schemaVersion.const) ||
        schema.properties.schemaVersion.const < 1
      ) {
        errors.push(`${path}: schemaVersion debe declarar un const entero mayor o igual a 1`);
      }
      if (schema.properties?.type?.const !== topic) {
        errors.push(`${path}: properties.type.const debe ser ${topic}`);
      }
      ajv.addSchema(schema);
    }
  } catch (error) {
    errors.push(`No se pudieron cargar los esquemas: ${error.message}`);
    return { errors, checked };
  }

  for (const topic of schemaTopics) {
    const schemaPath = resolve(SCHEMAS_DIR, `${topic}.schema.json`);
    const examplePath = resolve(EXAMPLES_DIR, `${topic}.example.json`);
    try {
      const message = readJson(examplePath);
      const schema = readJson(schemaPath);
      const validate = ajv.getSchema(schema.$id);
      if (!validate) {
        errors.push(`${schemaPath}: no se pudo compilar el esquema ${schema.$id ?? '(sin $id)'}`);
        continue;
      }

      checked += 1;
      if (message.type !== topic) {
        errors.push(`${examplePath}: type debe ser ${topic}`);
      }
      if (!validate(message)) {
        errors.push(`${examplePath}: ${describeAjvErrors(validate.errors)}`);
      }
    } catch (error) {
      errors.push(`${examplePath}: ${error.message}`);
    }
  }

  // Ejemplos inválidos: { description, expectedErrorPath, message }. Cada uno debe fallar y señalar
  // el campo esperado (un error en esa ruta o debajo de ella), no fallar por cualquier otro motivo.
  const invalidFiles = existsSync(INVALID_EXAMPLES_DIR) ? jsonFiles(INVALID_EXAMPLES_DIR, '.invalid.json') : [];
  for (const file of invalidFiles) {
    const invalidPath = resolve(INVALID_EXAMPLES_DIR, file);
    try {
      const { expectedErrorPath, message } = readJson(invalidPath);
      const topic = message?.type;
      if (typeof expectedErrorPath !== 'string' || !expectedErrorPath.startsWith('/')) {
        errors.push(`${invalidPath}: expectedErrorPath debe ser una ruta JSON Pointer (por ejemplo /data/trackingCode)`);
        continue;
      }
      if (typeof topic !== 'string' || !schemaTopics.includes(topic) || !file.startsWith(`${topic}.`)) {
        errors.push(`${invalidPath}: el nombre debe empezar con un tópico existente igual a message.type`);
        continue;
      }

      const validate = ajv.getSchema(readJson(resolve(SCHEMAS_DIR, `${topic}.schema.json`)).$id);
      checked += 1;
      if (validate(message)) {
        errors.push(`${invalidPath}: debía ser inválido`);
        continue;
      }
      const paths = (validate.errors ?? []).map((error) => error.instancePath || '/');
      const pointsAtField = paths.some(
        (path) => path === expectedErrorPath || path.startsWith(`${expectedErrorPath}/`),
      );
      if (!pointsAtField) {
        errors.push(
          `${invalidPath}: el error debía señalar ${expectedErrorPath} y señaló ${describeAjvErrors(validate.errors)}`,
        );
      }
    } catch (error) {
      errors.push(`${invalidPath}: ${error.message}`);
    }
  }

  for (const file of jsonFiles(FIXTURES_DIR, '.json')) {
    const fixturePath = resolve(FIXTURES_DIR, file);
    try {
      const fixture = readJson(fixturePath);
      if (!Array.isArray(fixture.steps) || fixture.steps.length === 0) {
        errors.push(`${fixturePath}: steps debe contener al menos un mensaje`);
        continue;
      }

      fixture.steps.forEach((step, index) => {
        const topic = step.message?.type;
        const label = `${fixturePath}: steps[${index}]${topic ? ` (${topic})` : ''}`;
        if (typeof topic !== 'string') {
          errors.push(`${label}: falta message.type`);
          return;
        }

        const schema = schemaTopics.includes(topic)
          ? readJson(resolve(SCHEMAS_DIR, `${topic}.schema.json`))
          : undefined;
        const validate = schema ? ajv.getSchema(schema.$id) : undefined;
        if (!validate) {
          errors.push(`${label}: no existe un esquema para el tópico`);
          return;
        }

        checked += 1;
        const valid = Boolean(validate(step.message));
        const expectedValid = step.expectInvalid !== true;
        if (valid !== expectedValid) {
          const expectation = expectedValid ? 'debía validar' : 'debía ser inválido';
          const detail = valid ? '' : ` (${describeAjvErrors(validate.errors)})`;
          errors.push(`${label}: ${expectation}${detail}`);
        }
      });
    } catch (error) {
      errors.push(`${fixturePath}: ${error.message}`);
    }
  }

  return { errors, checked };
};

try {
  const result = checkContracts();
  if (result.errors.length > 0) {
    process.stderr.write(`contracts:check encontró ${result.errors.length} problema(s):\n`);
    for (const error of result.errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`contracts:check correcto: ${result.checked} mensajes validados.\n`);
  }
} catch (error) {
    process.stderr.write(`contracts:check no pudo ejecutarse: ${error.message}\n`);
  process.exitCode = 1;
}
