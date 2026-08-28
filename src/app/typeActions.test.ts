// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFieldToType,
  addPropertyToEntry,
  changeFieldKind,
  findTypeDoc,
  normalizeFieldName,
  removeFieldFromType,
  setFieldOptions,
  setTypeDisplay,
  setTypeStatuses,
  setTypeViews,
} from '@/app/typeActions';
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

describe('setTypeDisplay (M44.1)', () => {
  const workItemTypeDoc = {
    ...typeDoc,
    path: 'types/work-item.md',
    title: 'Work item',
    properties: { fields: {} } as unknown as typeof typeDoc.properties,
  };

  beforeEach(() => {
    useVaultStore.setState({ entries: [workItemTypeDoc] });
  });

  it('writes only the deviations, snake_case, under display', async () => {
    const ok = await setTypeDisplay(
      { name: 'Work item', docPath: 'types/work-item.md' },
      { showEmpty: true, showFile: false, showBody: false },
    );
    expect(ok).toBe(true);
    expect(patches).toEqual([
      {
        path: 'types/work-item.md',
        patch: { display: { show_empty: true, show_body: false } },
      },
    ]);
  });

  it('all-defaults deletes the key — reset IS the write', async () => {
    await setTypeDisplay(
      { name: 'Work item', docPath: 'types/work-item.md' },
      { showEmpty: false, showFile: false, showBody: true },
    );
    expect(patches).toEqual([{ path: 'types/work-item.md', patch: { display: null } }]);
  });

  it('toasts and returns false when the write fails', async () => {
    useVaultStore.setState({
      patchFrontmatter: vi.fn().mockRejectedValue(new Error('disk')),
    });
    const ok = await setTypeDisplay(
      { name: 'Work item', docPath: 'types/work-item.md' },
      { showEmpty: true, showFile: false, showBody: true },
    );
    expect(ok).toBe(false);
    expect(toasts[0]).toMatch(/display/i);
  });

  // M44.1 follow-up: patchFrontmatter never rejects on a real disk failure —
  // it catches internally, toasts, and returns false. The action has to READ
  // that boolean instead of assuming the write landed whenever nothing threw.
  it('returns false when patchFrontmatter reports the write did not land, with no second toast', async () => {
    useVaultStore.setState({
      patchFrontmatter: vi.fn().mockResolvedValue(false),
    });
    const ok = await setTypeDisplay(
      { name: 'Work item', docPath: 'types/work-item.md' },
      { showEmpty: true, showFile: false, showBody: true },
    );
    expect(ok).toBe(false);
    expect(toasts).toEqual([]);
  });

  it('doc-null and deviating from defaults creates the Type doc via ensureTypeDoc', async () => {
    const ok = await setTypeDisplay(
      { name: 'Ghost Type', docPath: null },
      { showEmpty: true, showFile: false, showBody: true },
    );
    expect(ok).toBe(true);
    expect(created).toEqual([
      {
        folder: 'types',
        slug: 'ghost-type',
        frontmatter: { type: 'Type', display: { show_empty: true } },
        body: '# Ghost Type\n',
      },
    ]);
  });

  it('doc-null and all-defaults returns true and writes nothing', async () => {
    const ok = await setTypeDisplay(
      { name: 'Ghost Type', docPath: null },
      { showEmpty: false, showFile: false, showBody: true },
    );
    expect(ok).toBe(true);
    expect(created).toEqual([]);
    expect(patches).toEqual([]);
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
