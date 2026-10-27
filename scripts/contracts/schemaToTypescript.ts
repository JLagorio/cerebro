import { format } from 'prettier';

type ObjectValue = Record<string, unknown>;
const ANNOTATION_KEYS = new Set(['$schema', 'title', 'description']);

/** Schemars can emit the same declaration as both a root (with title/dialect)
 * and a reference definition. Compare shape independently of those annotations
 * and map/required-field order, while preserving every validation keyword. */
function shapeKey(value: unknown): string {
  const normalize = (entry: unknown, context: 'schema' | 'properties' | 'required'): unknown => {
    if (Array.isArray(entry)) {
      const items = entry.map((item) => normalize(item, 'schema'));
      return context === 'required' ? items.sort() : items;
    }
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([name]) => context === 'properties' || !ANNOTATION_KEYS.has(name))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, child]) => [
            name,
            normalize(
              child,
              context !== 'properties' && (name === 'properties' || name === 'required')
                ? name
                : 'schema',
            ),
          ]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value, 'schema'));
}

function object(value: unknown, context: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unsupported schema at ${context}: expected an object`);
  }
  return value as ObjectValue;
}

function identifier(name: string): string {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsupported type identifier: ${name}`);
  }
  return name;
}

/** A wire-shape projection, not a runtime validator. Deliberately rejects schema
 * constructs that this exporter cannot represent instead of widening to any.
 * New schema features require a tested projection before a DTO can adopt them. */
export async function schemaToTypescript(value: unknown): Promise<string> {
  const bundle = object(value, 'bundle');
  if (
    bundle.version !== 1 ||
    Object.keys(bundle).some((key) => key !== 'version' && key !== 'types')
  ) {
    throw new Error('unsupported contract bundle version or field');
  }
  const roots = object(bundle.types, 'types');
  const declarations = new Map<string, ObjectValue>();
  const add = (name: string, schema: unknown) => {
    identifier(name);
    const node = object(schema, name);
    const previous = declarations.get(name);
    if (previous && shapeKey(previous) !== shapeKey(node)) {
      throw new Error(`conflicting schema definition: ${name}`);
    }
    declarations.set(name, node);
  };
  for (const [name, schema] of Object.entries(roots)) {
    const root = object(schema, name);
    const { definitions, ...node } = root;
    add(name, node);
    for (const [childName, child] of Object.entries(
      object(definitions ?? {}, `${name}.definitions`),
    )) {
      add(childName, child);
    }
  }
  const render = (input: unknown, context: string): string => {
    const node = object(input, context);
    const keys = Object.keys(node).filter((key) => !ANNOTATION_KEYS.has(key));
    const only = (...allowed: string[]) => {
      const unsupported = keys.find((key) => !allowed.includes(key));
      if (unsupported) throw new Error(`unsupported schema at ${context}: ${unsupported}`);
    };
    if ('$ref' in node) {
      only('$ref');
      if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/definitions/')) {
        throw new Error(`unsupported reference at ${context}`);
      }
      const name = identifier(node.$ref.slice('#/definitions/'.length));
      if (!declarations.has(name)) throw new Error(`unresolved reference at ${context}: ${name}`);
      return name;
    }
    const union = 'anyOf' in node ? 'anyOf' : 'oneOf' in node ? 'oneOf' : null;
    if (union) {
      only(union);
      const variants = node[union];
      if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error(`unsupported empty union at ${context}`);
      }
      return `(${variants.map((variant, index) => render(variant, `${context}.${index}`)).join(' | ')})`;
    }
    if ('enum' in node) {
      only('type', 'enum');
      if (
        node.type !== 'string' ||
        !Array.isArray(node.enum) ||
        node.enum.length === 0 ||
        node.enum.some((entry) => typeof entry !== 'string')
      ) {
        throw new Error(`unsupported enum at ${context}`);
      }
      return node.enum.map((entry) => JSON.stringify(entry)).join(' | ');
    }
    if (Array.isArray(node.type)) {
      only('type');
      if (node.type.length === 0 || new Set(node.type).size !== node.type.length) {
        throw new Error(`unsupported schema type array at ${context}`);
      }
      return `(${node.type.map((type) => render({ type }, context)).join(' | ')})`;
    }
    if (node.type === 'string' || node.type === 'boolean' || node.type === 'null') {
      only('type');
      return node.type;
    }
    if (node.type === 'integer') {
      only('type', 'minimum', 'maximum');
      if (
        typeof node.minimum !== 'number' ||
        !Number.isSafeInteger(node.minimum) ||
        node.minimum < 0 ||
        typeof node.maximum !== 'number' ||
        !Number.isSafeInteger(node.maximum) ||
        node.maximum < node.minimum
      )
        throw new Error(`unsupported unsafe integer at ${context}`);
      return 'number';
    }
    if (node.type === 'array') {
      only('type', 'items');
      return `Array<${render(node.items, `${context}.items`)}>`;
    }
    if (node.type === 'object') {
      only('type', 'properties', 'required', 'additionalProperties');
      if (node.additionalProperties !== null && typeof node.additionalProperties === 'object') {
        if (node.properties !== undefined || node.required !== undefined) {
          throw new Error(`unsupported mixed dictionary/object at ${context}`);
        }
        return `Record<string, ${render(node.additionalProperties, `${context}.additionalProperties`)}>`;
      }
      if (node.additionalProperties !== false) {
        throw new Error(`unsupported open object at ${context}`);
      }
      const properties = object(node.properties ?? {}, `${context}.properties`);
      const required = node.required ?? [];
      if (
        !Array.isArray(required) ||
        required.some((name) => typeof name !== 'string' || !Object.hasOwn(properties, name))
      ) {
        throw new Error(`unsupported required fields at ${context}`);
      }
      return `{ ${Object.keys(properties)
        .sort()
        .map(
          (name) =>
            `${JSON.stringify(name)}${required.includes(name) ? '' : '?'}: ${render(properties[name], `${context}.${name}`)};`,
        )
        .join(' ')} }`;
    }
    throw new Error(`unsupported schema at ${context}: ${String(node.type)}`);
  };
  const source = [
    '// Generated from Rust-owned JSON Schema. Do not edit.',
    '// Regenerate with the commands in shared/workspace/README.md.',
    ...[...declarations]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, schema]) => `export type ${name} = ${render(schema, name)};`),
  ].join('\n\n');
  return format(source, { parser: 'typescript', printWidth: 100, singleQuote: true });
}
