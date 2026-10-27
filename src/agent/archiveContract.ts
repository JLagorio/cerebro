import CONTRACT from '../../shared/conversations/contracts.v1.json';

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural projection of Rust's generated schema; no permission/retention rules. */
function matches(schema: unknown, value: unknown, definitions: Schema, depth: number): boolean {
  if (!object(schema) || depth > 64) return false;
  if (typeof schema.$ref === 'string') {
    const prefix = '#/definitions/';
    return schema.$ref.startsWith(prefix) &&
      matches(definitions[schema.$ref.slice(prefix.length)], value, definitions, depth + 1);
  }
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union)) return union.some((item) => matches(item, value, definitions, depth + 1));
  if (Array.isArray(schema.type)) return schema.type.some((type) => matches({ type }, value, definitions, depth + 1));
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) &&
    typeof schema.minimum === 'number' && value >= schema.minimum &&
    typeof schema.maximum === 'number' && value <= schema.maximum;
  if (schema.type === 'array') return Array.isArray(value) && value.every((item) => matches(schema.items, item, definitions, depth + 1));
  if (schema.type === 'object') {
    if (!object(value) || !object(schema.properties) || schema.additionalProperties !== false) return false;
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required : [];
    return required.every((key) => typeof key === 'string' && Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => Object.hasOwn(properties, key) && matches(properties[key], value[key], definitions, depth + 1));
  }
  return false;
}

export function checkedArchive<T>(name: string, value: unknown): T {
  const types = CONTRACT.types as unknown as Record<string, Schema>;
  const schema = types[name];
  if (!schema || !matches(schema, value, object(schema.definitions) ? schema.definitions : {}, 0)) {
    throw { code: 'unavailable', message: 'Conversation archive returned an unavailable format.' };
  }
  return value as T;
}
