import source from '../../shared/policy/connector-ownership.v1.json';

export type ConnectorOwnership = 'cli' | 'managed' | 'invalid' | 'unavailable';

export interface ConnectorOwnershipPolicy {
  readonly format: 1;
  readonly artifact_version: number;
  readonly owner_field: string;
  readonly owners: readonly {
    readonly value: string;
    readonly disposition: 'cli' | 'managed';
  }[];
  readonly absent_owner: 'cli';
  readonly unknown_owner: 'invalid';
  readonly managed_only_fields: readonly string[];
  readonly cli_with_managed_field: 'invalid';
  readonly messages: Readonly<Record<'managed' | 'invalid' | 'unavailable', string>>;
}

const UNAVAILABLE_REASON = 'Connector ownership policy is unavailable.';
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
const message = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x20-\x7e]*$/.test(value) && /[^ ]/.test(value);
const sorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1] < value);

/** Unsupported/corrupt policy bytes are unavailable, never legacy CLI. */
export function readConnectorOwnershipPolicy(raw: string): ConnectorOwnershipPolicy | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !keys(value, [
      'format',
      'artifact_version',
      'owner_field',
      'owners',
      'absent_owner',
      'unknown_owner',
      'managed_only_fields',
      'cli_with_managed_field',
      'messages',
    ]) ||
    value.format !== 1 ||
    typeof value.artifact_version !== 'number' ||
    !Number.isSafeInteger(value.artifact_version) ||
    value.artifact_version <= 0 ||
    !identifier(value.owner_field) ||
    value.absent_owner !== 'cli' ||
    value.unknown_owner !== 'invalid' ||
    value.cli_with_managed_field !== 'invalid'
  )
    return null;
  if (
    !Array.isArray(value.owners) ||
    value.owners.length === 0 ||
    !value.owners.every(
      (rule) =>
        keys(rule, ['value', 'disposition']) &&
        identifier(rule.value) &&
        (rule.disposition === 'cli' || rule.disposition === 'managed'),
    )
  )
    return null;
  const owners = value.owners as ConnectorOwnershipPolicy['owners'];
  if (
    !sorted(owners.map((rule) => rule.value)) ||
    !owners.some((rule) => rule.disposition === 'cli') ||
    !owners.some((rule) => rule.disposition === 'managed')
  )
    return null;
  if (
    !Array.isArray(value.managed_only_fields) ||
    value.managed_only_fields.length === 0 ||
    !value.managed_only_fields.every((field) => identifier(field) && field !== value.owner_field) ||
    !sorted(value.managed_only_fields)
  )
    return null;
  if (
    !keys(value.messages, ['managed', 'invalid', 'unavailable']) ||
    !Object.values(value.messages).every(message)
  )
    return null;
  return value as unknown as ConnectorOwnershipPolicy;
}

export const CONNECTOR_OWNERSHIP_POLICY = readConnectorOwnershipPolicy(JSON.stringify(source));

/** Reads markers only; it neither resolves a reference nor infers account authority. */
export function connectorOwnership(
  entry: unknown,
  policy: ConnectorOwnershipPolicy | null = CONNECTOR_OWNERSHIP_POLICY,
): ConnectorOwnership {
  if (policy === null) return 'unavailable';
  if (!object(entry)) return 'invalid';
  const owner = entry[policy.owner_field];
  const disposition = !Object.hasOwn(entry, policy.owner_field)
    ? policy.absent_owner
    : typeof owner === 'string'
      ? (policy.owners.find((rule) => rule.value === owner)?.disposition ?? policy.unknown_owner)
      : policy.unknown_owner;
  return disposition === 'cli' &&
    policy.managed_only_fields.some((field) => Object.hasOwn(entry, field))
    ? policy.cli_with_managed_field
    : disposition;
}

/** Static words only; raw route/reference contents never enter a refusal. */
export function connectorOwnershipReason(
  entry: unknown,
  policy: ConnectorOwnershipPolicy | null = CONNECTOR_OWNERSHIP_POLICY,
): string | null {
  const ownership = connectorOwnership(entry, policy);
  return ownership === 'cli' ? null : (policy?.messages[ownership] ?? UNAVAILABLE_REASON);
}
