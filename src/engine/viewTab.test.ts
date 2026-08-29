import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/engine/schema';
import { relationFieldTargeting, resolveViewTab } from '@/engine/viewTab';
import { makeEntry } from '@/test/factories';
import type { Entry, ListFile, TabDef } from '@/engine/types';

/**
 * Two-type fixture: Project ← Task (the task holds the link), plus a Person
 * type a person field targets and a derived reciprocal on Project. The two
 * task spellings are the values-semantics proof: `evaluateFilters` intersects
 * strictly against the AUTHORED bracket-stripped targets, and `atlas` (stem)
 * and `Atlas` (title-case, still stem-resolved case-insensitively) are both
 * legal spellings of one host — a filter seeded with either alone misses the
 * other.
 */
function fixture(): Entry[] {
  return [
    makeEntry({
      path: 'types/project.md',
      title: 'Project',
      type: 'Type',
      properties: {
        fields: {
          // The derived side of the pair: stores nothing, must never gate.
          tasks: { kind: 'relation', from: { type: 'Task', field: 'project' } },
        },
      } as never,
    }),
    makeEntry({
      path: 'types/task.md',
      title: 'Task',
      type: 'Type',
      properties: {
        fields: {
          project: { kind: 'relation', target: 'Project' },
          owner: { kind: 'person', target: 'Person' },
        },
      } as never,
    }),
    makeEntry({ path: 'types/person.md', title: 'Person', type: 'Type' }),
    makeEntry({ path: 'projects/atlas.md', title: 'Atlas', type: 'Project' }),
    makeEntry({ path: 'projects/zeus.md', title: 'Zeus', type: 'Project' }),
    makeEntry({ path: 'people/ada.md', title: 'Ada', type: 'Person' }),
    makeEntry({
      path: 'tasks/t1.md',
      title: 'Wire the intake',
      type: 'Task',
      relationships: { project: ['atlas'] },
    }),
    makeEntry({
      path: 'tasks/t2.md',
      title: 'Ship the report',
      type: 'Task',
      // Title-case spelling: resolveTarget matches stems case-insensitively,
      // but a strict any_of over ['atlas'] alone would MISS this row.
      relationships: { project: ['Atlas'] },
    }),
    makeEntry({ path: 'tasks/t3.md', title: 'Unfiled chore', type: 'Task' }),
    makeEntry({
      path: 'tasks/t4.md',
      title: 'Other project work',
      type: 'Task',
      relationships: { project: ['zeus'] },
    }),
  ];
}

function makeList(patch: Partial<ListFile['definition']> = {}, id = 'work'): ListFile {
  return {
    id,
    collection: null,
    project: null,
    path: `views/${id}.list.yml`,
    definition: {
      name: 'Work',
      icon: null,
      color: null,
      order: null,
      source: { type: 'Task', project: null },
      views: [
        {
          id: 'main',
          name: 'All',
          icon: null,
          filters: null,
          presentation: { type: 'table', group: [], sort: [], columns: [] },
        },
      ],
      ...patch,
    },
  };
}

const freezeTab = (tab: TabDef): TabDef => {
  if (tab.source != null) Object.freeze(tab.source);
  return Object.freeze(tab);
};

const viewTab = (patch: Partial<TabDef>): TabDef =>
  freezeTab({ id: 'tab-1', name: 'Tasks', icon: null, content: 'view', source: null, ...patch });

function setup(lists: ListFile[] = []) {
  const entries = fixture();
  const schema = buildSchema(entries);
  const host = entries.find((e) => e.path === 'projects/atlas.md')!;
  return { entries, schema, host, lists };
}

describe('relationFieldTargeting', () => {
  it('finds the first stored relation-family field aimed at the host type', () => {
    const { schema } = setup();
    expect(relationFieldTargeting('Task', 'Project', schema)?.name).toBe('project');
    // A person field is a relation with an avatar renderer: same gate.
    expect(relationFieldTargeting('Task', 'Person', schema)?.name).toBe('owner');
  });

  it('answers null when no field targets the host type', () => {
    const { schema } = setup();
    expect(relationFieldTargeting('Task', 'Task', schema)).toBeNull();
    expect(relationFieldTargeting('Person', 'Project', schema)).toBeNull();
    // An unknown source type has no fields to gate on.
    expect(relationFieldTargeting('Ghost', 'Project', schema)).toBeNull();
  });

  it('skips the derived side of a two-way pair — it stores nothing to filter', () => {
    const { schema } = setup();
    // Project.tasks has `from: { type: 'Task', … }` and would name-match a
    // Task host, but its rows hold no values for a filter to read.
    expect(relationFieldTargeting('Project', 'Task', schema)).toBeNull();
  });
});

describe('resolveViewTab', () => {
  it('resolves a type source through the synthetic type selection', () => {
    const { entries, schema, host } = setup();
    const res = resolveViewTab(viewTab({ source: { type: 'Task' } }), host, entries, schema, []);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.sourceLabel).toBe('Task · Table');
    expect(res.surface.entries.map((e) => e.path).sort()).toEqual([
      'tasks/t1.md',
      'tasks/t2.md',
      'tasks/t3.md',
      'tasks/t4.md',
    ]);
  });

  it('resolves a list source by id AND collection, honoring the saved view id', () => {
    const { entries, schema, host } = setup();
    const list = makeList({
      views: [
        {
          id: 'main',
          name: 'All',
          icon: null,
          filters: null,
          presentation: { type: 'table', group: [], sort: [], columns: [] },
        },
        {
          id: 'board',
          name: 'Board',
          icon: null,
          filters: null,
          presentation: { type: 'board', group: [], sort: [], columns: [] },
        },
      ],
    });
    const res = resolveViewTab(
      viewTab({ source: { list: 'work', collection: null }, view: 'board' }),
      host,
      entries,
      schema,
      [list],
    );
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.sourceLabel).toBe('Work · Board');
    expect(res.surface.presentation.type).toBe('board');
    expect(res.surface.entries).toHaveLength(4);
  });

  it('is broken, in words, when the tab declares no source', () => {
    const { entries, schema, host } = setup();
    const res = resolveViewTab(viewTab({ source: null }), host, entries, schema, []);
    expect(res).toEqual({
      kind: 'broken',
      reason: 'This tab declares a view but does not say what it is a view of.',
    });
  });

  it('names the dead list rather than rendering empty', () => {
    const { entries, schema, host } = setup();
    const res = resolveViewTab(
      viewTab({ source: { list: 'tracker', collection: 'delivery' } }),
      host,
      entries,
      schema,
      [makeList()], // right id would still miss: the collection is part of the key
    );
    expect(res).toEqual({
      kind: 'broken',
      reason: 'This tab points at a list called “tracker” that is no longer in the vault.',
    });
  });

  it('names the dead type rather than rendering empty', () => {
    const { entries, schema, host } = setup();
    const res = resolveViewTab(viewTab({ source: { type: 'Invoice' } }), host, entries, schema, []);
    expect(res).toEqual({
      kind: 'broken',
      reason: 'This tab points at a type called “Invoice” that is no longer in the vault.',
    });
  });

  it('refuses a dashboard source — a record tab cannot show one', () => {
    const { entries, schema, host } = setup();
    const list = makeList({
      views: [
        {
          id: 'main',
          name: 'Overview',
          icon: null,
          filters: null,
          presentation: { type: 'dashboard', group: [], sort: [], columns: [] },
        },
      ],
    });
    const res = resolveViewTab(viewTab({ source: { list: 'work' } }), host, entries, schema, [
      list,
    ]);
    expect(res).toEqual({
      kind: 'broken',
      reason: 'A record tab cannot show a dashboard — pick one of its own views instead.',
    });
  });

  it('scopes related rows to the host through every authored spelling', () => {
    const { entries, schema, host } = setup();
    const res = resolveViewTab(
      viewTab({ source: { type: 'Task' }, scope: 'related' }),
      host,
      entries,
      schema,
      [],
    );
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    // `atlas` (stem) and `Atlas` (title-case) both resolve to the host and
    // both survive the strict any_of; zeus's task and the unlinked task do
    // not. This is the filter matching resolution semantics, not luck.
    expect(res.surface.entries.map((e) => e.path).sort()).toEqual(['tasks/t1.md', 'tasks/t2.md']);
  });

  it('related with no inbound rows is empty — never silently all', () => {
    const { entries, lists } = setup();
    const zeus = entries.find((e) => e.path === 'projects/zeus.md')!;
    // Rewire every task away from zeus so nothing points at it.
    const rewired = entries.map((e) =>
      e.type === 'Task' ? { ...e, relationships: { ...e.relationships, project: ['atlas'] } } : e,
    );
    const res = resolveViewTab(
      viewTab({ source: { type: 'Task' }, scope: 'related' }),
      zeus,
      rewired,
      buildSchema(rewired),
      lists,
    );
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    // A value-less any_of is "not ready" to evaluateFilters and would be
    // SKIPPED — every row, the forbidden reading. Zero rows is the truth.
    expect(res.surface.entries).toEqual([]);
  });

  it('related without a qualifying relation is broken, naming both types', () => {
    const { entries, schema, host } = setup();
    // Project has no STORED relation pointing at Project (its `tasks` field
    // is derived) — so a Projects view scoped to a Project host cannot mean
    // anything, and must say so instead of showing every project.
    const res = resolveViewTab(
      viewTab({ source: { type: 'Project' }, scope: 'related' }),
      host,
      entries,
      schema,
      [],
    );
    expect(res).toEqual({
      kind: 'broken',
      reason:
        'This tab scopes to related records, but “Project” has no relation pointing at “Project”.',
    });
  });

  it('related against an untyped host is broken — no type for a relation to target', () => {
    const { entries, schema } = setup();
    const untyped = makeEntry({ path: 'notes/scratch.md', title: 'Scratch' });
    const res = resolveViewTab(
      viewTab({ source: { type: 'Task' }, scope: 'related' }),
      untyped,
      entries,
      schema,
      [],
    );
    expect(res).toEqual({
      kind: 'broken',
      reason:
        'This tab scopes to related records, but this record has no type for a relation to target.',
    });
  });

  it('related against a typeless list is broken — no single type to relate from', () => {
    const { entries, schema, host } = setup();
    const everything = makeList({ name: 'Everything', source: { type: null, project: null } });
    const res = resolveViewTab(
      viewTab({ source: { list: 'work' }, scope: 'related' }),
      host,
      entries,
      schema,
      [everything],
    );
    expect(res).toEqual({
      kind: 'broken',
      reason:
        'This tab scopes to related records, but “Everything” shows records of no single type, so no relation can point at “Project”.',
    });
  });

  it('absent scope means every row, and related never touches the presentation', () => {
    const { entries, schema, host } = setup();
    const all = resolveViewTab(viewTab({ source: { type: 'Task' } }), host, entries, schema, []);
    const related = resolveViewTab(
      viewTab({ source: { type: 'Task' }, scope: 'related' }),
      host,
      entries,
      schema,
      [],
    );
    expect(all.kind).toBe('ok');
    expect(related.kind).toBe('ok');
    if (all.kind !== 'ok' || related.kind !== 'ok') return;
    expect(all.surface.entries).toHaveLength(4);
    // Scoping filters ENTRIES; the presentation is the saved view's, byte
    // for byte — the widgetEntries layering idiom.
    expect(related.surface.presentation).toEqual(all.surface.presentation);
  });
});
