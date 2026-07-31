import { describe, expect, it } from 'vitest';
import { analyzeVault, inferKind } from './adopt';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';

// M12.6: the schema doctor. An Obsidian vault arrives with years of freeform
// frontmatter; the analysis proposes the schema it implies and the writes
// that make every record fit.

describe('inferKind', () => {
  it('reads homogeneous primitives', () => {
    expect(inferKind('estimate', [1, 3, 5])).toBe('number');
    expect(inferKind('blocked', [true, false])).toBe('checkbox');
    expect(inferKind('due', ['2026-01-02', '2026-03-04T10:00:00Z'])).toBe('date');
  });

  it('reads a small repeated vocabulary as select', () => {
    expect(inferKind('severity', ['high', 'low', 'high', 'medium'])).toBe('select');
  });

  it('does not read prose or unique values as select', () => {
    expect(inferKind('note', ['every value different', 'another one', 'third'])).toBe('text');
    expect(inferKind('summary', ['a genuinely long sentence about the thing itself'])).toBe(
      'text',
    );
  });

  it('status is status by name', () => {
    expect(inferKind('status', ['open', 'closed', 'open'])).toBe('status');
  });

  it('arrays read as multiselect', () => {
    expect(inferKind('tags', [['a', 'b'], ['a']])).toBe('multiselect');
  });
});

describe('analyzeVault', () => {
  const risk = (n: number, props: Record<string, unknown>, rels: Record<string, string[]> = {}) =>
    makeEntry({
      path: `records/risks/rsk-${n}.md`,
      filename: `rsk-${n}.md`,
      folder: 'records/risks',
      title: `Risk ${n}`,
      type: 'Risk',
      properties: props,
      relationships: rels,
    });
  const epic = makeEntry({
    path: 'records/epics/epic-1.md',
    filename: 'epic-1.md',
    folder: 'records/epics',
    title: 'Epic one',
    type: 'Epic',
  });
  const epicType = makeEntry({
    path: 'types/epic.md',
    filename: 'epic.md',
    folder: 'types',
    title: 'Epic',
    type: 'Type',
  });

  it('proposes a ghost type with inferred kinds, targets, and conversions', () => {
    const entries = [
      risk(1, { severity: 'high', likelihood: 3, due: '2026-08-01' }, { epic: ['epic-1'] }),
      risk(2, { severity: 'low', likelihood: 'unknown', due: 'next week' }, { epic: ['epic-1'] }),
      // Two real dates against one "next week": a 2/3 majority reads as date.
      risk(3, { severity: 'high', likelihood: 5, due: '2026-09-15' }),
      epic,
      epicType,
    ];
    const proposals = analyzeVault(entries, buildSchema(entries));
    const riskProposal = proposals.find((p) => p.name === 'Risk');
    expect(riskProposal).toBeDefined();
    expect(riskProposal!.docPath).toBeNull();
    expect(riskProposal!.records).toBe(3);

    const byName = new Map(riskProposal!.fields.map((f) => [f.name, f]));
    expect(byName.get('severity')).toMatchObject({
      kind: 'select',
      options: ['high', 'low'],
      convert: [],
    });
    // 'unknown' has no numeric reading — cleared, not mangled.
    expect(byName.get('likelihood')).toMatchObject({ kind: 'number' });
    expect(byName.get('likelihood')!.convert).toEqual([
      { path: 'records/risks/rsk-2.md', value: null },
    ]);
    // 'next week' is not a date — cleared.
    expect(byName.get('due')).toMatchObject({ kind: 'date' });
    expect(byName.get('due')!.convert).toEqual([{ path: 'records/risks/rsk-2.md', value: null }]);
    // The wikilink key becomes an enforced relation, target from resolution.
    expect(byName.get('epic')).toMatchObject({ kind: 'relation', target: 'Epic' });
  });

  it('proposes nothing for a fully adopted vault — the Repair Vault rule', () => {
    const riskType = makeEntry({
      path: 'types/risk.md',
      filename: 'risk.md',
      folder: 'types',
      title: 'Risk',
      type: 'Type',
      properties: {
        fields: { severity: { kind: 'select', options: ['high', 'low'] } },
      } as unknown as ReturnType<typeof makeEntry>['properties'],
    });
    const entries = [riskType, risk(1, { severity: 'high' })];
    expect(analyzeVault(entries, buildSchema(entries))).toEqual([]);
  });

  it('flags ill-fitting values on an already-declared field', () => {
    const riskType = makeEntry({
      path: 'types/risk.md',
      filename: 'risk.md',
      folder: 'types',
      title: 'Risk',
      type: 'Type',
      properties: {
        fields: { likelihood: { kind: 'number' } },
      } as unknown as ReturnType<typeof makeEntry>['properties'],
    });
    const entries = [riskType, risk(1, { likelihood: 'high' }), risk(2, { likelihood: 4 })];
    const proposals = analyzeVault(entries, buildSchema(entries));
    expect(proposals).toHaveLength(1);
    const field = proposals[0].fields[0];
    expect(field).toMatchObject({ name: 'likelihood', kind: 'number', declared: true });
    expect(field.convert).toEqual([{ path: 'records/risks/rsk-1.md', value: null }]);
  });

  it('ignores templates, the knowledge bundle, and untyped docs', () => {
    const entries = [
      makeEntry({ path: 'templates/risk.md', folder: 'templates', type: 'Risk' }),
      makeEntry({ path: 'knowledge/concepts/x.md', folder: 'knowledge/concepts', type: 'Metric' }),
      makeEntry({ path: 'notes/plain.md', folder: 'notes', type: null }),
    ];
    expect(analyzeVault(entries, buildSchema(entries))).toEqual([]);
  });
});
