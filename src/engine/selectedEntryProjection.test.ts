import { describe, expect, it } from 'vitest';
import type { PropertyValue, SelectedEntryProperties } from '@/lib/generated/workspace';
import { columnUniverse } from './columns';
import { buildSchema } from './schema';
import { resolveSurface, resolveTypeView } from './surface';
import { makeEntry } from './testHelpers';
import type { Entry, ListFile, Presentation, ViewDefinition } from './types';

const authority = {
  kind: 'sqlite_metadata' as const,
  workspaceId: '92a042cd-c957-489c-aa85-4c67cccfb102',
  recordId: '13ef0f93-fd47-4a0a-b10e-5d845c3c38f3',
  metadataRevision: '2',
  metadataHash: 'a'.repeat(64),
  bodyHash: 'b'.repeat(64),
};

function selected(
  values: Record<string, PropertyValue>,
  properties: Record<string, unknown> = {},
  unavailableLegacyKeys: string[] = Object.keys(values),
): Entry {
  const canonicalProperties: SelectedEntryProperties = {
    value: { kind: 'object', value: values },
    unavailableLegacyKeys,
  };
  return Object.assign(
    makeEntry({ path: 'page.md', title: 'Original page', type: 'Task', authority, properties }),
    { canonicalProperties },
  );
}

function typeNote(fields: Record<string, unknown> = { amount: 'number', due: 'date' }): Entry {
  return makeEntry({ path: 'types/task.md', title: 'Task', type: 'Type', properties: { fields } });
}

function view(presentation: Partial<Presentation> = {}): ViewDefinition {
  return {
    id: 'all', name: 'All', icon: null, filters: null,
    presentation: { type: 'table', group: [], sort: [{ field: 'title', dir: 'asc' }], columns: [], ...presentation },
  };
}

function unavailable(surface: ReturnType<typeof resolveTypeView>): void {
  expect(surface).toMatchObject({ unavailable: {
    kind: 'unsupported_projection', code: 'capability_unavailable', retryable: false,
    message: expect.any(String),
  } });
  // The denied computation must not publish an apparently complete empty or partial answer.
  expect(surface.entries).toEqual([]);
}

describe('actual selected Entry carrier consumers', () => {
  it.each(['9007199254740993.12345678901234567890123456789', '1e400'])('displays the exact Decimal %s without a legacy numeric value', (lexeme) => {
    const value: PropertyValue = { kind: 'decimal', value: lexeme };
    const entry = selected({ amount: value });
    const schema = buildSchema([typeNote(), entry]);
    expect(schema.resolveField(entry, 'amount')).toMatchObject({
      display: lexeme, selectedValue: { kind: 'present', value },
    });
    expect(schema.resolveField(entry, 'amount').raw).toBeUndefined();
    expect(schema.fieldValue(entry, 'amount')).toBeUndefined();
  });

  it('keeps a local Date tag and exact day distinct from a legacy timestamp', () => {
    const value: PropertyValue = { kind: 'date', value: '2028-02-29' };
    const entry = selected({ due: value });
    const field = buildSchema([typeNote(), entry]).resolveField(entry, 'due');
    expect(field).toMatchObject({ display: '2028-02-29', selectedValue: { kind: 'present', value } });
  });

  it('distinguishes explicit null from an absent field', () => {
    const entry = selected({ amount: { kind: 'null' } });
    const schema = buildSchema([typeNote(), entry]);
    expect(schema.resolveField(entry, 'amount')).toMatchObject({ selectedValue: { kind: 'present', value: { kind: 'null' } } });
    expect(schema.resolveField(entry, 'due')).toMatchObject({ selectedValue: { kind: 'absent' } });
  });

  it('does not fall back to a compatible map when a selected carrier is absent', () => {
    const entry = makeEntry({ authority, properties: { amount: 42 } });
    const schema = buildSchema([entry]);
    expect(schema.resolveField(entry, 'amount')).toMatchObject({ unavailableReason: expect.any(String) });
    expect(schema.resolveField(entry, 'amount').display).not.toBe('42');
    expect(schema.fieldValue(entry, 'amount')).toBeUndefined();
  });

  it('does not bless a malformed non-object carrier as an empty metadata object', () => {
    const entry = Object.assign(makeEntry({ authority, properties: { amount: 42 } }), {
      canonicalProperties: { value: { kind: 'decimal', value: '42' }, unavailableLegacyKeys: [] } satisfies SelectedEntryProperties,
    });
    expect(buildSchema([entry]).resolveField(entry, 'amount')).toMatchObject({ unavailableReason: expect.any(String) });
  });

  it.each([
    { kind: 'object', value: { nested: { kind: 'decimal', value: '1e400' } } },
    { kind: 'relation', spelling: 'Other', resolution: { status: 'resolved', targetId: authority.recordId } },
    { kind: 'instant', value: '2028-02-29T23:00:00.123456789-08:00' },
  ] satisfies PropertyValue[])('retains unsupported $kind visibly rather than blank or stringify', (value) => {
    const entry = selected({ detail: value });
    expect(buildSchema([entry]).resolveField(entry, 'detail')).toMatchObject({
      selectedValue: { kind: 'present', value }, unavailableReason: expect.any(String),
    });
  });

  it('includes canonical undeclared keys omitted by the legacy compatibility map', () => {
    const entry = selected({ exact: { kind: 'decimal', value: '1e400' } });
    expect(columnUniverse({ type: null, project: null }, [entry], buildSchema([entry])).map((f) => f.name)).toContain('exact');
  });

  it('does not mistake an inherited object key for a present canonical property', () => {
    const entry = selected({});
    expect(buildSchema([entry]).resolveField(entry, 'constructor')).toMatchObject({ selectedValue: { kind: 'absent' } });
  });

  it('marks unavailable reserved Type configuration instead of inventing an empty schema', () => {
    const entry = Object.assign(selected({ fields: { kind: 'object', value: { amount: { kind: 'decimal', value: '1e400' } } } }), {
      path: 'types/task.md', title: 'Task', type: 'Type',
    });
    expect(buildSchema([entry]).types.get('Task')).toMatchObject({ unavailableReason: expect.any(String) });
  });

  it('does not evaluate a selected formula from legacy-compatible numeric hints', () => {
    const entry = selected({ amount: { kind: 'decimal', value: '42' } }, { amount: 42 }, []);
    const schema = buildSchema([typeNote({ amount: 'number', doubled: { kind: 'formula', formula: 'amount * 2' } }), entry]);
    expect(schema.resolveField(entry, 'doubled')).toMatchObject({ unavailableReason: expect.any(String) });
    expect(schema.fieldValue(entry, 'doubled')).toBeUndefined();
  });

  it('leaves the ordinary legacy numeric path unchanged', () => {
    const entry = makeEntry({ type: 'Task', properties: { amount: 42 } });
    const schema = buildSchema([typeNote(), entry]);
    expect(schema.fieldValue(entry, 'amount')).toBe(42);
    expect(schema.resolveField(entry, 'amount').display).toBe('42');
  });
});

describe('selected surface dependency preflight before legacy evaluation', () => {
  const entry = selected({ amount: { kind: 'decimal', value: '1e400' } });
  const entries = [typeNote(), entry];

  it('keeps an unfiltered path/title ordered source and exact cells usable', () => {
    const result = resolveTypeView('Task', view({ columns: [{ field: 'amount' }] }), entries, buildSchema(entries));
    expect(result.entries).toEqual([entry]);
    expect(result).not.toHaveProperty('unavailable');
  });

  it('refuses a hidden metadata predicate instead of publishing a false empty answer', () => {
    const requested = { ...view(), filters: { all: [{ field: 'amount', op: 'gt' as const, value: 1 }] } };
    unavailable(resolveTypeView('Task', requested, entries, buildSchema(entries)));
  });

  it.each([
    ['sort', { sort: [{ field: 'amount', dir: 'asc' as const }] }],
    ['group', { group: [{ field: 'amount' }] }],
    ['relation descent', { group: [{ field: 'related', descend: { direction: 'forward' as const, field: 'related' } }] }],
    ['hidden footer', { columns: [{ field: 'amount', hidden: true, calc: 'sum' as const }] }],
    ['date axis', { type: 'calendar' as const, dateField: 'due' }],
    ['chart measure', { type: 'chart' as const, chart: { kind: 'number' as const, agg: 'sum' as const, value: 'amount' } }],
    ['dashboard measure', { type: 'dashboard' as const, dashboard: { rows: [{ id: 'row', widgets: [{ id: 'sum', kind: 'number' as const, agg: 'sum' as const, value: 'amount' }] }] } }],
  ] satisfies [string, Partial<Presentation>][])('refuses an unadopted %s dependency even when its field is not visible', (_label, presentation) => {
    unavailable(resolveTypeView('Task', view(presentation), entries, buildSchema(entries)));
  });

  it('refuses an ordinary selected source whose carrier was not issued', () => {
    const missing = makeEntry({ type: 'Task', authority, properties: { amount: 42 } });
    unavailable(resolveTypeView('Task', view(), [missing], buildSchema([missing])));
  });

  it('does not render default Type views after reserved schema configuration was unavailable', () => {
    const brokenType = Object.assign(selected({ fields: { kind: 'object', value: { amount: { kind: 'decimal', value: '1e400' } } } }), { path: 'types/task.md', type: 'Type', title: 'Task' });
    unavailable(resolveTypeView('Task', view(), [brokenType, entry], buildSchema([brokenType, entry])));
  });

  it('applies the same preflight through the actual saved-list resolver', () => {
    const list: ListFile = { id: 'all', path: 'all.list.yml', project: null, collection: null,
      definition: { name: 'All', icon: null, color: null, order: null, source: { type: 'Task', project: null }, views: [view({ sort: [{ field: 'amount', dir: 'asc' }] })] },
    };
    unavailable(resolveSurface({ kind: 'list', id: 'all' }, entries, buildSchema(entries), [list]));
  });
});
