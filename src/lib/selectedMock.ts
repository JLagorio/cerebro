/** Test-only selected workspace fixture authority, separate from legacy mock files. */
import type {
  AuthorityError,
  PropertyValue,
  SelectedMetadataAck,
  SelectedEntryProperties,
  SelectedMode,
  SelectedRecordVersion,
} from './generated/workspace';
import RULES from '../../shared/workspace/authority.v2.json';
import VALUE_RULES from '../../shared/workspace/values.v1.json';
import { parseDateText } from '@/engine/dateGrammar';
import { sha256Hex } from './sha256';
import type { RawList } from './ipc';

export interface SelectedMockSeed {
  vault: string;
  workspaceId: string;
  records: readonly {
    id: string;
    path: string;
    body: string;
    metadata: PropertyValue;
    pairedBodyHash?: string;
  }[];
  views?: readonly RawList[];
  collections?: readonly { folder: string; yaml: string }[];
}
interface RecordState {
  id: string;
  path: string;
  body: string;
  metadata: PropertyValue;
  revision: bigint;
  pairedBodyHash: string;
}
interface Fixture {
  workspaceId: string;
  records: RecordState[];
  marker: 'activated' | 'missing' | 'invalid';
  views: RawList[];
  collections: { folder: string; yaml: string }[];
  epoch: bigint;
  receipts: { actor: string; operation: string; recordId: string; revision: string }[];
}
const fixtures = new Map<string, Fixture>();

function refusal(kind: AuthorityError['kind'], message: string): AuthorityError {
  return { code: 'capability_unavailable', kind, message, retryable: false };
}
function active(vault: string): Fixture | null {
  const fixture = fixtures.get(vault);
  if (fixture === undefined) return null;
  if (fixture.marker !== 'activated')
    throw refusal(
      fixture.marker === 'missing' ? 'missing_marker' : 'invalid_format',
      'The selected workspace authority is unavailable.',
    );
  return fixture;
}
function testOnly(): void {
  if (import.meta.env.MODE !== 'test') throw new Error('Selected fixture setup is test-only.');
}
export function seedSelectedWorkspaceForTest(seed: SelectedMockSeed): void {
  testOnly();
  if (fixtures.has(seed.vault)) throw new Error('This fixture workspace is already registered.');
  fixtures.set(seed.vault, {
    workspaceId: seed.workspaceId,
    records: structuredClone(seed.records).map((record) => ({
      ...record,
      revision: 1n,
      pairedBodyHash: record.pairedBodyHash ?? sha256Hex(record.body),
    })),
    marker: 'activated',
    views: structuredClone(seed.views ?? []).slice(),
    collections: structuredClone(seed.collections ?? []).slice(),
    epoch: 1n,
    receipts: [],
  });
}
export function resetSelectedWorkspacesForTest(): void {
  testOnly();
  fixtures.clear();
}
export function selectedFixtureForTest(vault: string) {
  testOnly();
  return structuredClone(fixtures.get(vault));
}
export function setSelectedMarkerForTest(vault: string, marker: Fixture['marker']): void {
  testOnly();
  const fixture = fixtures.get(vault);
  if (fixture === undefined) throw new Error('Missing selected fixture.');
  fixture.marker = marker;
}
/** A legacy door may not fall through merely because the marker disappeared. */
export function guardMockLegacy(vault: string, command: string): void {
  const fixture = active(vault);
  if (fixture === null) return;
  const policy = RULES.nativeCommands.find((row) => row.command === command);
  if (policy === undefined)
    throw refusal('unsupported_operation', 'This selected workspace command is unsupported.');
  throw refusal(
    'unsupported_operation',
    `This operation is unavailable for selected workspaces (${policy.command}).`,
  );
}
export function guardMockDestination(path: string): void {
  for (const root of fixtures.keys()) {
    const target = path.replace(/\/+$/, '');
    if (target === root || target.startsWith(`${root}/`) || root.startsWith(`${target}/`)) {
      active(root);
      throw refusal('unsupported_operation', 'This destination belongs to a selected workspace.');
    }
  }
}
export function isSelectedMock(vault: string): boolean {
  return active(vault) !== null;
}

/** Mirrors only the accepted exact legacy DTO projection, from shared cases. */
export function projectSelectedValue(value: PropertyValue): unknown {
  switch (value.kind) {
    case 'null':
      return null;
    case 'boolean':
    case 'string':
      return value.value;
    case 'date':
    case 'instant': {
      const parsed = parseDateText(value.value);
      if (
        value.value.trim() !== value.value ||
        parsed === null ||
        (value.kind === 'date' ? parsed.instant || parsed.time !== null : !parsed.instant)
      )
        throw refusal('invalid_metadata', 'The explicitly tagged date value is invalid.');
      return value.value;
    }
    case 'array':
      return value.value.map(projectSelectedValue);
    case 'object':
      return Object.fromEntries(
        Object.entries(value.value).map(([key, item]) => [key, projectSelectedValue(item)]),
      );
    case 'decimal': {
      if (
        !new RegExp(VALUE_RULES.decimal.pattern).test(value.value) ||
        value.value.length > VALUE_RULES.decimal.maxLexemeBytes
      )
        throw refusal('invalid_metadata', 'The decimal lexeme is invalid.');
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(value.value) || value.value === '-0')
        throw refusal(
          'unsupported_projection',
          'This exact decimal spelling cannot be represented by the page DTO.',
        );
      const exact = BigInt(value.value);
      const max = BigInt(VALUE_RULES.decimal.legacyMaxSafeInteger);
      if (exact < -max || exact > max)
        throw refusal(
          'unsupported_projection',
          'This exact decimal cannot be represented by the page DTO.',
        );
      return Number(exact);
    }
    case 'relation':
      throw refusal(
        'unsupported_projection',
        'This page DTO cannot retain typed relation identity.',
      );
  }
}
/** Per-key compatibility parity for the actual selected scan carrier. */
export function projectSelectedMetadata(metadata: PropertyValue): {
  properties: Record<string, unknown>;
  type: string | null;
  canonicalProperties: SelectedEntryProperties;
} {
  if (metadata.kind !== 'object')
    throw refusal('invalid_metadata', 'Canonical metadata must be an object.');
  const declaredType = Object.hasOwn(metadata.value, 'type') ? metadata.value.type : undefined;
  if (declaredType && declaredType.kind !== 'string' && declaredType.kind !== 'null')
    throw refusal('unsupported_projection', 'Canonical page type must be text or absent.');
  const properties: Record<string, unknown> = Object.create(null);
  const unavailableLegacyKeys: string[] = [];
  for (const [key, value] of Object.entries(metadata.value)) {
    try {
      properties[key] = projectSelectedValue(value);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('kind' in error) ||
        error.kind !== 'unsupported_projection'
      )
        throw error;
      unavailableLegacyKeys.push(key);
    }
  }
  return {
    properties,
    type: declaredType?.kind === 'string' ? declaredType.value : null,
    canonicalProperties: {
      value: structuredClone(metadata),
      unavailableLegacyKeys: unavailableLegacyKeys.sort(unicodeOrder),
    },
  };
}

function unicodeOrder(left: string, right: string): number {
  const a = [...left],
    b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
/** Same field order as Rust tagged variants; object keys use Rust string order. */
function ordered(value: PropertyValue): PropertyValue {
  switch (value.kind) {
    case 'null':
      return { kind: 'null' };
    case 'string':
    case 'boolean':
    case 'decimal':
    case 'date':
    case 'instant':
      return { kind: value.kind, value: value.value } as PropertyValue;
    case 'array':
      return { kind: 'array', value: value.value.map(ordered) };
    case 'object':
      return {
        kind: 'object',
        value: Object.fromEntries(
          Object.keys(value.value)
            .sort(unicodeOrder)
            .map((key) => [key, ordered(value.value[key])]),
        ),
      };
    case 'relation':
      return {
        kind: 'relation',
        spelling: value.spelling,
        fragment: value.fragment,
        resolution:
          value.resolution.status === 'resolved'
            ? { status: 'resolved', targetId: value.resolution.targetId }
            : { status: value.resolution.status },
      };
  }
}
function source(value: PropertyValue): string {
  return JSON.stringify(ordered(value));
}
function version(fixture: Fixture, record: RecordState): SelectedRecordVersion {
  if (sha256Hex(record.body) !== record.pairedBodyHash)
    throw refusal('source_changed', 'The visible body disagrees with its canonical pairing.');
  return {
    kind: 'sqlite_metadata',
    workspaceId: fixture.workspaceId,
    recordId: record.id,
    metadataRevision: record.revision.toString(),
    metadataHash: sha256Hex(source(record.metadata)),
    bodyHash: record.pairedBodyHash,
  };
}
export function scanSelectedMock(vault: string) {
  const fixture = active(vault);
  if (fixture === null) return null;
  return fixture.records.map((record) => ({
    path: record.path,
    body: record.body,
    metadata: structuredClone(record.metadata),
    version: version(fixture, record),
  }));
}
export function readSelectedMock(vault: string, path: string): string | null {
  const fixture = active(vault);
  if (fixture === null) return null;
  const record = fixture.records.find((item) => item.path === path);
  if (record === undefined)
    throw refusal('metadata_unavailable', 'The selected record is unavailable.');
  version(fixture, record);
  return record.body;
}
export function selectedFolders(vault: string): string[] | null {
  const fixture = active(vault);
  if (fixture === null) return null;
  const folders = new Set<string>();
  for (const record of fixture.records) {
    let folder = record.path.split('/').slice(0, -1).join('/');
    while (folder !== '') {
      folders.add(folder);
      folder = folder.split('/').slice(0, -1).join('/');
    }
  }
  return [...folders].sort();
}
export function setSelectedFullWidth(
  vault: string,
  path: string,
  expected: SelectedRecordVersion,
  mode: SelectedMode,
): SelectedMetadataAck {
  const fixture = active(vault);
  if (fixture === null)
    throw refusal('unbound_workspace', 'This workspace has no selected fixture binding.');
  const record = fixture.records.find((item) => item.path === path);
  if (record === undefined)
    throw refusal('metadata_unavailable', 'The selected record is unavailable.');
  const observed = version(fixture, record);
  if (
    expected.kind !== 'sqlite_metadata' ||
    expected.workspaceId !== observed.workspaceId ||
    expected.recordId !== observed.recordId
  )
    throw refusal('wrong_identity', 'The selected record identity changed.');
  if (expected.bodyHash !== observed.bodyHash)
    throw refusal('source_changed', 'The paired body changed.');
  if (
    expected.metadataRevision !== observed.metadataRevision ||
    expected.metadataHash !== observed.metadataHash
  )
    throw refusal('stale_metadata', 'The selected metadata changed.');
  if (record.metadata.kind !== 'object')
    throw refusal('invalid_metadata', 'Canonical metadata must be an object.');
  if (mode !== 'wide' && mode !== 'default')
    throw refusal('unsupported_operation', 'This presentation action is unsupported.');
  const properties = record.metadata.value;
  const unchanged =
    mode === 'wide'
      ? properties.full_width?.kind === 'boolean' && properties.full_width.value === true
      : !Object.hasOwn(properties, 'full_width');
  if (unchanged) return { kind: 'unchanged', version: observed, fullWidth: mode === 'wide' };
  if (record.revision >= BigInt(RULES.revision.max) || fixture.epoch >= BigInt(RULES.revision.max))
    throw refusal('source_limit', 'The selected metadata counter is exhausted.');
  if (mode === 'wide') properties.full_width = { kind: 'boolean', value: true };
  else delete properties.full_width;
  record.revision += 1n;
  fixture.epoch += 1n;
  fixture.receipts.push({
    actor: 'human:me',
    operation: 'page.full_width',
    recordId: record.id,
    revision: record.revision.toString(),
  });
  return { kind: 'applied', version: version(fixture, record), fullWidth: mode === 'wide' };
}

export function selectedRetainedReads(vault: string) {
  const fixture = active(vault);
  return fixture === null
    ? null
    : { views: structuredClone(fixture.views), collections: structuredClone(fixture.collections) };
}
