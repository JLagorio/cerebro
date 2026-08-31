// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFieldToType,
  addPropertyToEntry,
  applyTypeLayout,
  changeFieldKind,
  createDatabase,
  findTypeDoc,
  normalizeFieldName,
  removeFieldFromType,
  renameFieldOnType,
  setFieldOptions,
  setTypeStatuses,
  setTypeTabs,
  setTypeViews,
  type TypeLayoutDraft,
} from '@/app/typeActions';
import { recordsFolder } from '@/engine/createRecord';
import { makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const typeDoc = makeEntry({
  path: 'types/recipe.md',
  title: 'Recipe',
  type: 'Type',
  properties: {
    icon: 'chef-hat',
    fields: { cuisine: { kind: 'text' } },
  } as unknown as ReturnType<typeof makeEntry>['properties'],
});

let patches: { path: string; patch: Record<string, unknown> }[];
let created: Record<string, unknown>[];
let toasts: string[];

beforeEach(() => {
  patches = [];
  created = [];
  toasts = [];
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [typeDoc],
    status: 'ready',
    patchFrontmatter: vi.fn(async (path: string, patch: Record<string, unknown>) => {
      patches.push({ path, patch });
      return true;
    }),
    createItem: vi.fn(async (args: Record<string, unknown>) => {
      created.push(args);
      return 'types/new.md';
    }),
  });
  useUiStore.setState({
    toast: (message: string) => {
      toasts.push(message);
    },
  });
});

describe('normalizeFieldName', () => {
  it('lowercases and underscores whitespace', () => {
    expect(normalizeFieldName('  Due Date ')).toBe('due_date');
  });
});

describe('findTypeDoc', () => {
  it('matches exactly, then case-insensitively (title drift)', () => {
    expect(findTypeDoc([typeDoc], 'Recipe')?.path).toBe('types/recipe.md');
    expect(findTypeDoc([typeDoc], 'recipe')?.path).toBe('types/recipe.md');
    expect(findTypeDoc([typeDoc], 'Book')).toBeNull();
  });
});

describe('addFieldToType', () => {
  it('merges the new field into the existing fields mapping', async () => {
    expect(await addFieldToType('Recipe', 'servings', 'number')).toBe(true);
    expect(patches).toEqual([
      {
        path: 'types/recipe.md',
        patch: { fields: { cuisine: { kind: 'text' }, servings: { kind: 'number' } } },
      },
    ]);
  });

  it('writes bare-string specs for text fields', async () => {
    await addFieldToType('Recipe', 'source', 'text');
    expect(patches[0].patch.fields).toMatchObject({ source: 'text' });
  });

  it('creates the Type doc when the type has none (system/ghost types)', async () => {
    expect(await addFieldToType('Work item', 'severity', 'select')).toBe(true);
    expect(patches).toEqual([]);
    expect(created).toEqual([
      {
        folder: 'types',
        slug: 'work-item',
        frontmatter: { type: 'Type', fields: { severity: { kind: 'select' } } },
        body: '# Work item\n',
      },
    ]);
  });

  it('rejects duplicates case-insensitively', async () => {
    expect(await addFieldToType('Recipe', 'Cuisine', 'text')).toBe(false);
    expect(patches).toEqual([]);
    expect(toasts).toEqual(['Property already exists']);
  });

  it('rejects reserved schema keys', async () => {
    expect(await addFieldToType('Recipe', 'statuses', 'text')).toBe(false);
    // M45.1: `layout` joined the roster.
    expect(await addFieldToType('Recipe', 'layout', 'text')).toBe(false);
    expect(patches).toEqual([]);
    expect(toasts[0]).toMatch(/reserved/);
  });

  it('refuses to clobber a type doc with YAML errors', async () => {
    useVaultStore.setState({
      entries: [{ ...typeDoc, parseError: 'bad yaml', properties: {} }],
    });
    expect(await addFieldToType('Recipe', 'servings', 'number')).toBe(false);
    expect(patches).toEqual([]);
    expect(toasts[0]).toMatch(/YAML errors/);
  });
});

describe('removeFieldFromType', () => {
  it('removes a custom field from the mapping', async () => {
    expect(await removeFieldFromType('Recipe', 'cuisine')).toBe(true);
    expect(patches).toEqual([{ path: 'types/recipe.md', patch: { fields: {} } }]);
  });

  it('removes what used to be a locked built-in — no type is system anymore', async () => {
    // M12.2: Work item lost its standard-object status; its fields are as
    // editable as anyone's. (The metamodel's own keys stay locked, but they
    // are reserved keys, not declared fields — covered by addFieldToType.)
    useVaultStore.setState({
      entries: [
        {
          ...typeDoc,
          path: 'types/work-item.md',
          title: 'Work item',
          properties: {
            fields: { status: { kind: 'status' } },
          } as unknown as typeof typeDoc.properties,
        },
      ],
    });
    expect(await removeFieldFromType('Work item', 'status')).toBe(true);
    expect(patches).toEqual([{ path: 'types/work-item.md', patch: { fields: {} } }]);
  });
});

describe('renameFieldOnType', () => {
  // M44.1 follow-up: the per-record migration loop used to count failures
  // inside a try/catch waiting for a rejection patchFrontmatter never
  // produces — the `failed` counter, and the aggregate toast it gates, were
  // dead code. This pins the now-live path: a record write that comes back
  // `false` is counted, and the toast fires with the real count.
  it('counts records whose value write reports false, and toasts the aggregate', async () => {
    useVaultStore.setState({
      entries: [
        typeDoc,
        makeEntry({
          path: 'recipes/a.md',
          title: 'A',
          type: 'Recipe',
          properties: { cuisine: 'thai' },
        }),
        makeEntry({
          path: 'recipes/b.md',
          title: 'B',
          type: 'Recipe',
          properties: { cuisine: 'oaxacan' },
        }),
      ],
      patchFrontmatter: vi.fn(async (path: string, patch: Record<string, unknown>) => {
        patches.push({ path, patch });
        return path !== 'recipes/b.md';
      }),
    });
    const ok = await renameFieldOnType('Recipe', 'cuisine', 'flavor');
    expect(ok).toBe(true);
    expect(toasts).toEqual(['Renamed, but 1 record(s) kept the old value']);
  });
});

describe('setFieldOptions', () => {
  it('writes the option list onto the field spec', async () => {
    expect(
      await setFieldOptions('Recipe', 'cuisine', [
        { id: 'thai', label: 'Thai', color: '#DE3B4E' },
        { id: 'oaxacan', label: 'Oaxacan', color: null },
      ]),
    ).toBe(true);
    expect(patches[0].patch.fields).toEqual({
      cuisine: {
        kind: 'text',
        options: [{ id: 'thai', color: '#DE3B4E' }, 'oaxacan'],
      },
    });
  });

  it('refuses built-in fields of system types', async () => {
    expect(await setFieldOptions('Work item', 'priority', [])).toBe(false);
    expect(patches).toEqual([]);
  });
});

// M44.1 follow-up: patchFrontmatter never rejects on a real disk failure — it
// catches internally, toasts, and returns false. setTypeStatuses/setTypeViews
// have to READ that boolean instead of assuming the write landed whenever
// nothing threw.
describe('setTypeStatuses (M44.1 follow-up)', () => {
  it('returns false when patchFrontmatter reports the write did not land, with no second toast', async () => {
    useVaultStore.setState({
      patchFrontmatter: vi.fn().mockResolvedValue(false),
    });
    const ok = await setTypeStatuses({ name: 'Recipe', docPath: 'types/recipe.md' }, [
      { id: 'todo', label: 'Todo', color: null, group: 'active' },
    ]);
    expect(ok).toBe(false);
    expect(toasts).toEqual([]);
  });
});

describe('setTypeViews (M44.1 follow-up)', () => {
  it('returns false when patchFrontmatter reports the write did not land, with no second toast', async () => {
    useVaultStore.setState({
      patchFrontmatter: vi.fn().mockResolvedValue(false),
    });
    const ok = await setTypeViews({ name: 'Recipe', docPath: 'types/recipe.md' }, [
      {
        id: 'v1',
        name: 'Board',
        icon: null,
        filters: null,
        presentation: { type: 'table', group: [], sort: [], columns: [] },
      },
    ]);
    expect(ok).toBe(false);
    expect(toasts).toEqual([]);
  });
});

describe('setTypeTabs (M44.5)', () => {
  const workItemTypeDoc = {
    ...typeDoc,
    path: 'types/work-item.md',
    title: 'Work item',
    properties: { fields: {} } as unknown as typeof typeDoc.properties,
  };

  beforeEach(() => {
    useVaultStore.setState({ entries: [workItemTypeDoc] });
  });

  it('writes the whole serialized list', async () => {
    const ok = await setTypeTabs({ name: 'Work item', docPath: 'types/work-item.md' }, [
      { id: 'overview', name: 'Overview', icon: null, content: 'overview' },
      { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
    ]);
    expect(ok).toBe(true);
    expect(patches).toEqual([
      {
        path: 'types/work-item.md',
        patch: {
          tabs: [
            { id: 'overview', name: 'Overview', icon: null, content: 'overview' },
            { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
          ],
        },
      },
    ]);
  });

  it('an empty list deletes the key — back to the synthesized default', async () => {
    const ok = await setTypeTabs({ name: 'Work item', docPath: 'types/work-item.md' }, []);
    expect(ok).toBe(true);
    expect(patches).toEqual([{ path: 'types/work-item.md', patch: { tabs: null } }]);
  });

  // M44.1-family follow-up: patchFrontmatter never rejects on a real disk
  // failure — it catches internally, toasts, and returns false. The action
  // has to READ that boolean instead of assuming the write landed whenever
  // nothing threw.
  it('returns false when patchFrontmatter reports the write did not land, with no second toast', async () => {
    useVaultStore.setState({
      patchFrontmatter: vi.fn().mockResolvedValue(false),
    });
    const ok = await setTypeTabs({ name: 'Work item', docPath: 'types/work-item.md' }, [
      { id: 'overview', name: 'Overview', icon: null, content: 'overview' },
    ]);
    expect(ok).toBe(false);
    expect(toasts).toEqual([]);
  });

  it('doc-null and a saved list creates the Type doc via ensureTypeDoc', async () => {
    const ok = await setTypeTabs({ name: 'Ghost Type', docPath: null }, [
      { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
    ]);
    expect(ok).toBe(true);
    expect(created).toEqual([
      {
        folder: 'types',
        slug: 'ghost-type',
        frontmatter: {
          type: 'Type',
          tabs: [{ id: 'spec', name: 'Spec', icon: null, content: 'sections' }],
        },
        body: '# Ghost Type\n',
      },
    ]);
  });

  it('doc-null and an empty list returns true and writes nothing', async () => {
    const ok = await setTypeTabs({ name: 'Ghost Type', docPath: null }, []);
    expect(ok).toBe(true);
    expect(created).toEqual([]);
    expect(patches).toEqual([]);
  });
});

describe('applyTypeLayout (M45.1)', () => {
  // A raw mapping deliberately wider than the model: `foo: bar` is a key we
  // don't parse, `notes: 'text'` is the bare-string shorthand, and `due`
  // carries a visibility the draft will clear.
  const workItemTypeDoc = {
    ...typeDoc,
    path: 'types/work-item.md',
    title: 'Work item',
    properties: {
      fields: {
        status: { kind: 'status' },
        due: { kind: 'date', visibility: 'hide', foo: 'bar' },
        notes: 'text',
      },
    } as unknown as typeof typeDoc.properties,
  };
  const listing = { name: 'Work item', docPath: 'types/work-item.md' };
  const blank = (): TypeLayoutDraft => ({
    display: { showEmpty: false, showFile: false, showBody: true },
    layout: { heading: [], groups: [] },
    tabs: [],
    visibility: {},
    added: [],
  });

  beforeEach(() => {
    useVaultStore.setState({ entries: [workItemTypeDoc] });
  });

  it('writes the whole draft — display, layout, tabs, merged fields — in ONE patch', async () => {
    const ok = await applyTypeLayout(listing, {
      display: { showEmpty: true, showFile: false, showBody: true },
      layout: {
        heading: ['status'],
        groups: [{ id: 'group-1', name: 'Details', fields: ['due'] }],
      },
      tabs: [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }],
      visibility: { notes: 'hide', due: null },
      added: [{ name: ' Estimate ', kind: 'number' }],
    });
    expect(ok).toBe(true);
    expect(patches).toEqual([
      {
        path: 'types/work-item.md',
        patch: {
          display: { show_empty: true },
          layout: {
            heading: ['status'],
            groups: [{ id: 'group-1', name: 'Details', fields: ['due'] }],
          },
          tabs: [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }],
          fields: {
            status: { kind: 'status' },
            // visibility: null deleted the key; the unmodeled `foo` survived.
            due: { kind: 'date', foo: 'bar' },
            // The bare shorthand grew into a mapping to hold the visibility.
            notes: { kind: 'text', visibility: 'hide' },
            // Appended last, name normalized.
            estimate: { kind: 'number' },
          },
        },
      },
    ]);
    // Declaration order is a locked Decision, and toEqual is key-order-blind:
    // a clone that reordered the mapping would pass it. Pin the order itself —
    // untouched and grown slots keep their place, appends land last.
    expect(Object.keys(patches[0].patch.fields as Record<string, unknown>)).toEqual([
      'status',
      'due',
      'notes',
      'estimate',
    ]);
  });

  it('omits fields when the draft stages no field deltas; defaults spell null', async () => {
    const draft = blank();
    draft.layout = { heading: ['status'], groups: [] };
    expect(await applyTypeLayout(listing, draft)).toBe(true);
    expect(patches).toEqual([
      {
        path: 'types/work-item.md',
        patch: { display: null, layout: { heading: ['status'] }, tabs: null },
      },
    ]);
  });

  it('refuses a reserved added name BEFORE any write — atomic means no partial', async () => {
    const draft = blank();
    draft.display = { showEmpty: true, showFile: false, showBody: true };
    draft.added = [{ name: 'Layout', kind: 'text' }];
    expect(await applyTypeLayout(listing, draft)).toBe(false);
    expect(patches).toEqual([]);
    expect(created).toEqual([]);
    expect(toasts[0]).toMatch(/reserved/);
  });

  it('refuses an added name that normalizes to nothing, before any write', async () => {
    const draft = blank();
    draft.display = { showEmpty: true, showFile: false, showBody: true };
    draft.added = [{ name: '   ', kind: 'text' }];
    expect(await applyTypeLayout(listing, draft)).toBe(false);
    expect(patches).toEqual([]);
    expect(created).toEqual([]);
    expect(toasts[0]).toMatch(/name/i);
  });

  it('refuses duplicate added names case-insensitively — existing and staged alike', async () => {
    const draft = blank();
    draft.added = [{ name: 'Status', kind: 'text' }];
    expect(await applyTypeLayout(listing, draft)).toBe(false);
    const twice = blank();
    twice.added = [
      { name: 'points', kind: 'number' },
      { name: ' Points ', kind: 'text' },
    ];
    expect(await applyTypeLayout(listing, twice)).toBe(false);
    expect(patches).toEqual([]);
    expect(toasts).toEqual(['Property already exists', 'Property already exists']);
  });

  // The additions merge in BEFORE the visibility walk (M45.3): a staged eye
  // on a staged-added field must land, not silently drop — the canvas
  // previewed it folded, so the vault has to write what the preview showed.
  it('a staged eye on a staged-added field survives Apply', async () => {
    const draft = blank();
    draft.added = [{ name: 'estimate', kind: 'number' }];
    draft.visibility = { estimate: 'hide' };
    expect(await applyTypeLayout(listing, draft)).toBe(true);
    expect(patches[0].patch.fields).toMatchObject({
      estimate: { kind: 'number', visibility: 'hide' },
    });
  });

  it('drops a staged visibility for a field the doc no longer declares — never declares it', async () => {
    const draft = blank();
    draft.visibility = { ghost: 'hide' };
    expect(await applyTypeLayout(listing, draft)).toBe(true);
    expect(patches).toEqual([]);
  });

  // visibility: null means "back to show", which absence already spells — so
  // aimed at a bare shorthand (`notes: 'text'`) or at a mapping that never
  // carried the key (`status`), it is a true no-op: no growth into a mapping,
  // and no write at all when nothing else changed.
  it('visibility null on a shorthand or an unset mapping is a no-op — no growth, no write', async () => {
    const draft = blank();
    draft.visibility = { notes: null, status: null };
    expect(await applyTypeLayout(listing, draft)).toBe(true);
    expect(patches).toEqual([]);
    // ...and staged beside a real change, it still counts as no field delta:
    // the landed patch carries no `fields` key, so the shorthand stays bare.
    const withDisplay = blank();
    withDisplay.display = { showEmpty: true, showFile: false, showBody: true };
    withDisplay.visibility = { notes: null };
    expect(await applyTypeLayout(listing, withDisplay)).toBe(true);
    expect(patches).toEqual([
      {
        path: 'types/work-item.md',
        patch: { display: { show_empty: true }, layout: null, tabs: null },
      },
    ]);
  });

  // M44.1-family contract: patchFrontmatter toasts and reverts itself — the
  // action reads its answer and adds nothing.
  it('returns false when patchFrontmatter reports the write did not land, with no second toast', async () => {
    useVaultStore.setState({ patchFrontmatter: vi.fn().mockResolvedValue(false) });
    const draft = blank();
    draft.tabs = [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }];
    expect(await applyTypeLayout(listing, draft)).toBe(false);
    expect(toasts).toEqual([]);
  });

  it('toasts and returns false when the write throws', async () => {
    useVaultStore.setState({ patchFrontmatter: vi.fn().mockRejectedValue(new Error('disk')) });
    const draft = blank();
    draft.tabs = [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }];
    expect(await applyTypeLayout(listing, draft)).toBe(false);
    expect(toasts[0]).toMatch(/layout/i);
  });

  it('doc-null and a non-default draft creates the Type doc via ensureTypeDoc', async () => {
    const draft = blank();
    draft.tabs = [{ id: 'spec', name: 'Spec', icon: null, content: 'sections' }];
    draft.added = [{ name: 'severity', kind: 'select' }];
    expect(await applyTypeLayout({ name: 'Ghost Type', docPath: null }, draft)).toBe(true);
    expect(patches).toEqual([]);
    expect(created).toEqual([
      {
        folder: 'types',
        slug: 'ghost-type',
        frontmatter: {
          type: 'Type',
          fields: { severity: { kind: 'select' } },
          tabs: [{ id: 'spec', name: 'Spec', icon: null, content: 'sections' }],
        },
        body: '# Ghost Type\n',
      },
    ]);
  });

  // Ported from setTypeDisplay's suite (retired M45.2): a display-only
  // deviation must reach ensureTypeDoc's frontmatter — the doc-null test
  // above deviates via tabs+added, so the display spread was unpinned.
  it('doc-null and a display-only deviation creates the Type doc carrying display', async () => {
    const draft = blank();
    draft.display = { showEmpty: true, showFile: false, showBody: true };
    expect(await applyTypeLayout({ name: 'Ghost Type', docPath: null }, draft)).toBe(true);
    expect(patches).toEqual([]);
    expect(created).toEqual([
      {
        folder: 'types',
        slug: 'ghost-type',
        frontmatter: { type: 'Type', display: { show_empty: true } },
        body: '# Ghost Type\n',
      },
    ]);
  });

  it('doc-null and an all-defaults draft returns true and writes nothing', async () => {
    expect(await applyTypeLayout({ name: 'Ghost Type', docPath: null }, blank())).toBe(true);
    expect(created).toEqual([]);
    expect(patches).toEqual([]);
  });

  // The cheaper honest behavior: deleting three keys the doc never carried is
  // a whole-file disk round-trip that changes nothing, so it is skipped.
  it('an all-defaults draft against a doc that never carried the keys writes nothing', async () => {
    expect(await applyTypeLayout(listing, blank())).toBe(true);
    expect(patches).toEqual([]);
  });

  // ...but the moment any of the three IS on disk, reset is a real write.
  it('an all-defaults draft still resets a doc that carries one of the keys', async () => {
    useVaultStore.setState({
      entries: [
        {
          ...workItemTypeDoc,
          properties: {
            fields: {},
            display: { show_empty: true },
          } as unknown as typeof typeDoc.properties,
        },
      ],
    });
    expect(await applyTypeLayout(listing, blank())).toBe(true);
    expect(patches).toEqual([
      { path: 'types/work-item.md', patch: { display: null, layout: null, tabs: null } },
    ]);
  });
});

describe('addPropertyToEntry', () => {
  it('extends the type schema for typed docs', async () => {
    const doc = makeEntry({ path: 'recipes/pasta.md', title: 'Pasta', type: 'Recipe' });
    expect(await addPropertyToEntry(doc, 'Prep Time', 'number')).toBe(true);
    expect(patches[0].path).toBe('types/recipe.md');
    expect(patches[0].patch.fields).toMatchObject({ prep_time: { kind: 'number' } });
  });

  it('seeds loose frontmatter on untyped docs', async () => {
    const doc = makeEntry({ path: 'notes/loose.md', title: 'Loose' });
    expect(await addPropertyToEntry(doc, 'mood', 'text')).toBe(true);
    expect(patches).toEqual([{ path: 'notes/loose.md', patch: { mood: '' } }]);
  });

  it('rejects names the doc already carries', async () => {
    const doc = makeEntry({
      path: 'notes/loose.md',
      title: 'Loose',
      properties: { mood: 'calm' },
    });
    expect(await addPropertyToEntry(doc, 'Mood', 'text')).toBe(false);
    expect(toasts).toEqual(['Property already exists']);
  });

  it('rejects computed kinds on untyped docs', async () => {
    const doc = makeEntry({ path: 'notes/loose.md', title: 'Loose' });
    expect(await addPropertyToEntry(doc, 'age', 'rollup')).toBe(false);
    expect(toasts[0]).toMatch(/Computed/);
  });
});

/**
 * M20.3. `KIND_KEYS` — the table naming what each kind's spec may carry — had
 * exactly one row consulted (`options`); every other entry in it was dead. So
 * changing a field's kind silently destroyed the wiring the declaration was
 * for, and none of it is recoverable from the value data.
 */
describe('changeFieldKind keeps the wiring the new kind understands', () => {
  const withField = (spec: Record<string, unknown>) =>
    makeEntry({
      path: 'types/task.md',
      title: 'Task',
      type: 'Type',
      properties: { fields: { rel: spec } } as unknown as Record<string, never>,
    });

  const specAfter = async (
    from: Record<string, unknown>,
    to: Parameters<typeof changeFieldKind>[2],
  ) => {
    const patches: { path: string; patch: Record<string, unknown> }[] = [];
    useVaultStore.setState({
      vaultPath: '/v',
      entries: [withField(from)],
      status: 'ready',
      patchFrontmatter: vi.fn(async (path: string, patch: Record<string, unknown>) => {
        patches.push({ path, patch });
        return true;
      }),
    });
    await changeFieldKind('Task', 'rel', to);
    const fields = patches[0].patch.fields as Record<string, Record<string, unknown>>;
    return fields.rel;
  };

  // A person field IS a relation with an avatar renderer (M16.13b), so the
  // conversion between them must not leave the picker pointing at nothing.
  it('carries target and limit across relation ⇄ person', async () => {
    expect(await specAfter({ kind: 'relation', target: 'Person', limit: 1 }, 'person')).toEqual({
      kind: 'person',
      target: 'Person',
      limit: 1,
    });
  });

  it('keeps a number’s format and precision', async () => {
    expect(await specAfter({ kind: 'text', format: 'percent', precision: 2 }, 'number')).toEqual({
      kind: 'number',
      format: 'percent',
      precision: 2,
    });
  });

  // The allowlist is what the NEW kind can read, so a key it cannot is still
  // dropped rather than carried along as dead YAML.
  it('drops what the new kind has no reading for', async () => {
    expect(await specAfter({ kind: 'relation', target: 'Person', limit: 1 }, 'text')).toEqual({
      kind: 'text',
    });
  });
});

/**
 * Door 2 of the M47 spec (M47.4): create a database without leaving the page.
 *
 * The first writer of `folder:` in the app's history. The key has been
 * RESERVED since M12.2 and parsed into `TypeDef.folder` ever since, but no
 * action ever set it — it was hand-edit-only, which is why "where do my new
 * records go" had no answer you could give from inside the app.
 */
describe('createDatabase (M47.4)', () => {
  it('writes a Type doc that declares its own home folder', async () => {
    expect(await createDatabase('Reading list')).toBe('Reading list');
    expect(created).toHaveLength(1);
    const fm = created[0].frontmatter as Record<string, unknown>;
    expect(created[0].folder).toBe('types');
    expect(created[0].slug).toBe('reading-list');
    expect(fm.type).toBe('Type');
    expect(fm.folder).toBe('records/reading-lists');
  });

  /**
   * `records/<plural>` is exactly what `createTarget` would have fallen back
   * to anyway. Writing it DOWN is the point: a home you can see in the file is
   * one a user can edit to `reading/`, and a home only the code knows is one
   * they cannot.
   */
  it('declares the same folder the convention would have chosen implicitly', async () => {
    await createDatabase('Recipe box');
    const fm = created[0].frontmatter as Record<string, unknown>;
    expect(fm.folder).toBe(recordsFolder('Recipe box'));
  });

  it('is born usable: a status field and a vocabulary for it', async () => {
    await createDatabase('Habit');
    const fm = created[0].frontmatter as Record<string, unknown>;
    expect(fm.fields).toEqual({ status: { kind: 'status' } });
    expect((fm.statuses as { id: string }[]).map((s) => s.id)).toEqual([
      'todo',
      'progress',
      'done',
    ]);
  });

  /**
   * The ids and groups are the vault's OWN, taken from `types/work-item.md`,
   * so a database created here and one written by hand agree instead of
   * growing two vocabularies for one idea.
   */
  it('borrows the vault status groups rather than inventing new ones', async () => {
    await createDatabase('Habit');
    const fm = created[0].frontmatter as Record<string, unknown>;
    for (const s of fm.statuses as { id: string; group: string }[]) {
      expect(['active', 'done', 'closed']).toContain(s.group);
    }
  });

  it('refuses a name already taken, toasting rather than throwing', async () => {
    expect(await createDatabase('Recipe')).toBeNull();
    expect(created).toHaveLength(0);
    expect(toasts.join(' ')).toContain('already exists');
  });

  it('refuses a blank name silently — nothing was asked for', async () => {
    expect(await createDatabase('   ')).toBeNull();
    expect(created).toHaveLength(0);
    expect(toasts).toEqual([]);
  });

  /**
   * A human-UI action, so a failed write toasts and answers null rather than
   * throwing (the store-layer error invariant). The caller keeps the name the
   * user typed on screen to fix.
   */
  it('answers null and toasts when the write fails', async () => {
    useVaultStore.setState({
      createItem: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    expect(await createDatabase('Reading list')).toBeNull();
    expect(toasts.join(' ')).toContain("Couldn't create");
  });
});
