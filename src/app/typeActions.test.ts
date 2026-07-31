// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFieldToType,
  addPropertyToEntry,
  findTypeDoc,
  normalizeFieldName,
  removeFieldFromType,
  setFieldOptions,
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
