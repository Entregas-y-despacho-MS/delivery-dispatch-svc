import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const ROOT = resolve(import.meta.dirname, '../..');
const CONTRACTS = resolve(ROOT, 'contracts/messages');
const SCHEMAS_DIR = resolve(CONTRACTS, 'schemas');
const EXAMPLES_DIR = resolve(CONTRACTS, 'examples');

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const jsonFiles = (directory, suffix) =>
  readdirSync(directory)
    .filter((file) => file.endsWith(suffix))
    .sort();

const topicNames = (directory, suffix) =>
  jsonFiles(directory, suffix).map((file) => file.slice(0, -suffix.length));

const catalogPath = () => {
  const configuredPath = process.env.CONTRACTS_CATALOG_PATH;
  if (configuredPath) {
    const path = resolve(configuredPath);
    if (!existsSync(path)) {
      throw new Error(`CONTRACTS_CATALOG_PATH no existe: ${path}`);
    }
    return path;
  }

  // The docs repository is a sibling of the service in normal checkouts and
  // two levels above service worktrees under backend/worktrees/.
  let parent = ROOT;
  for (let level = 0; level < 5; level += 1) {
    parent = dirname(parent);
    const candidate = resolve(parent, 'delivery-dispatch-docs/interoperabilidad-y-flujos.md');
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'No se encontró delivery-dispatch-docs/interoperabilidad-y-flujos.md. ' +
      'Configura CONTRACTS_CATALOG_PATH con la ruta del catálogo.',
  );
};

const catalogTopics = (path) => {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('### 1.4.');
  const end = text.indexOf('### 1.5.', start + 1);
  if (start < 0 || end < 0) {
    throw new Error(`No se encontró la sección 1.4 del catálogo: ${path}`);
  }

  return [...text.slice(start, end).matchAll(/^\| `([a-z_]+\.[a-z_]+\.[a-z_]+)` \|/gm)]
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
  const catalog = catalogTopics(catalogPath());

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
