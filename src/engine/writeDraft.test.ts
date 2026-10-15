import { describe, expect, it } from 'vitest';
import {
  applyDraftEdits,
  changedKeys,
  DRAFT_FIELD,
  draftRefusal,
  projectDraftForm,
  readFieldText,
  type DraftField,
} from './writeDraft';
import { toolSchema } from '@/lib/policy/tools';

/**
 * A write card's draft as a form (M57.4b): projected from the manifest's
 * input schema with no per-tool code, flat fields plus the whole draft.
 */

const keysOf = (fields: DraftField[]) => fields.map((f) => `${f.key}:${f.kind}`);

describe('projectDraftForm', () => {
  it('gives create_note folder, slug and body flat, and frontmatter in the draft', () => {
    const args = { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' };
    const form = projectDraftForm('Create a note', toolSchema('create_note'), args);
    expect(form.title).toBe('Create a note');
    expect(keysOf(form.fields)).toEqual([
      'folder:text',
      'slug:text',
      'body:text',
      `${DRAFT_FIELD}:json`,
    ]);
    expect(form.required).toEqual(['folder', 'slug', 'body']);
    const body = form.fields.find((f) => f.key === 'body');
    expect(body).toMatchObject({
      value: '# Vendor delay\n',
      required: true,
      hint: 'Markdown body, starting with an H1',
    });
    expect(form.fields.at(-1)?.value).toBe(JSON.stringify(args, null, 2));
  });

  it('gives update_frontmatter path flat and patch in the draft', () => {
    const form = projectDraftForm('Update', toolSchema('mcp__cerebro__update_frontmatter'), {
      path: 'a.md',
      patch: { status: 'done' },
    });
    expect(keysOf(form.fields)).toEqual(['path:text', 'expect_hash:text', `${DRAFT_FIELD}:json`]);
    expect(form.fields[1]).toMatchObject({ required: false, value: undefined });
  });

  it('gives edit_note path and expect_hash flat and edits in the draft', () => {
    const form = projectDraftForm('Edit', toolSchema('edit_note'), {
      path: 'a.md',
      edits: [{ old: 'a', new: 'b' }],
    });
    expect(keysOf(form.fields)).toEqual(['path:text', 'expect_hash:text', `${DRAFT_FIELD}:json`]);
  });

  it('reads a nullable string as text, and an enum or a const union as a choice', () => {
    const schema = {
      type: 'object',
      properties: {
        note: { type: ['string', 'null'] },
        maybe: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        size: { type: 'string', enum: ['s', 'm', 'l'] },
        tone: { oneOf: [{ const: 'calm' }, { const: 'firm' }] },
        flag: { type: 'boolean' },
        ratio: { type: 'number' },
        mixed: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        tags: { type: 'array' },
      },
      required: ['size'],
    };
    const form = projectDraftForm('T', schema, { note: null, tone: 'firm' });
    expect(keysOf(form.fields)).toEqual([
      'note:text',
      'maybe:integer',
      'size:choice',
      'tone:choice',
      'flag:boolean',
      'ratio:number',
      `${DRAFT_FIELD}:json`,
    ]);
    expect(form.fields[0]).toMatchObject({ nullable: true, value: null });
    expect(form.fields[1]).toMatchObject({ nullable: true });
    expect(form.fields[2]).toMatchObject({ options: ['s', 'm', 'l'], required: true });
    expect(form.fields[3]).toMatchObject({ options: ['calm', 'firm'], value: 'firm' });
  });

  it('gives only the draft field for a schema with no properties', () => {
    expect(keysOf(projectDraftForm('T', { type: 'object' }, { a: 1 }).fields)).toEqual([
      `${DRAFT_FIELD}:json`,
    ]);
    expect(keysOf(projectDraftForm('T', null, {}).fields)).toEqual([`${DRAFT_FIELD}:json`]);
  });
});

describe('applyDraftEdits', () => {
  const draft = { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' };

  it('lets a flat edit overwrite its argument and keeps untouched fields', () => {
    expect(applyDraftEdits(draft, { body: '# Vendor delay risk\n' })).toEqual({
      ...draft,
      body: '# Vendor delay risk\n',
    });
    expect(applyDraftEdits(draft, {})).toEqual(draft);
    expect(applyDraftEdits({ ...draft, expect_hash: 'h' }, { expect_hash: undefined })).toEqual(
      draft,
    );
  });

  it('lets a whole draft win, as an object and as JSON text', () => {
    const whole = { folder: 'records', slug: 's', body: '# S\n' };
    expect(applyDraftEdits(draft, { [DRAFT_FIELD]: whole, body: 'ignored' })).toEqual(whole);
    expect(applyDraftEdits(draft, { [DRAFT_FIELD]: JSON.stringify(whole) })).toEqual(whole);
  });

  it('falls back to the flat fields when the whole draft does not parse to an object', () => {
    expect(applyDraftEdits(draft, { [DRAFT_FIELD]: '{ nope', slug: 'v2' })).toEqual({
      ...draft,
      slug: 'v2',
    });
    expect(applyDraftEdits(draft, { [DRAFT_FIELD]: '[1, 2]' })).toEqual(draft);
  });
});

describe('changedKeys', () => {
  it('names added, removed and changed keys, sorted, ignoring key order inside values', () => {
    const asked = { a: 1, b: { x: 1, y: 2 }, c: 'same' };
    expect(changedKeys(asked, { b: { y: 2, x: 1 }, c: 'same', d: null, a: 2 })).toEqual(['a', 'd']);
    expect(changedKeys(asked, asked)).toEqual([]);
    expect(changedKeys(asked, {})).toEqual(['a', 'b', 'c']);
  });
});

describe('draftRefusal', () => {
  const schema = toolSchema('create_note');
  const good = { folder: '', slug: 'v', body: '# V\n' };

  it('admits a draft of the declared shape', () => {
    expect(draftRefusal(schema, good)).toBeNull();
    expect(draftRefusal(schema, { ...good, frontmatter: {} })).toBeNull();
  });

  it('refuses in Rust’s words, naming the key', () => {
    expect(draftRefusal(schema, [good])).toBe('The edited draft must be a JSON object.');
    expect(draftRefusal(schema, { folder: '', body: '' })).toBe(
      'The edited draft leaves out slug, which this tool requires.',
    );
    expect(draftRefusal(schema, { ...good, path: 'x' })).toBe(
      'The edited draft has path, which this tool does not take.',
    );
    expect(draftRefusal(schema, { ...good, body: 7 })).toBe(
      "The edited draft's body must be a string.",
    );
    expect(draftRefusal(schema, { ...good, frontmatter: null })).toBe(
      "The edited draft's frontmatter must be an object.",
    );
  });
});

describe('readFieldText', () => {
  const field = (over: Partial<DraftField>): DraftField => ({
    key: 'k',
    kind: 'text',
    hint: null,
    required: false,
    nullable: false,
    options: [],
    value: undefined,
    ...over,
  });

  it('reads empty text by what the field allows', () => {
    expect(readFieldText(field({ required: true }), '')).toEqual({ value: '' });
    expect(readFieldText(field({ nullable: true }), '')).toEqual({ value: null });
    expect(readFieldText(field({}), '')).toEqual({ value: undefined });
    expect(readFieldText(field({ kind: 'integer', required: true }), '')).toBe('invalid');
  });

  it('refuses a fraction for an integer and nonsense for a number', () => {
    expect(readFieldText(field({ kind: 'integer' }), '3')).toEqual({ value: 3 });
    expect(readFieldText(field({ kind: 'integer' }), '1.5')).toBe('invalid');
    expect(readFieldText(field({ kind: 'number' }), '1.5')).toEqual({ value: 1.5 });
    expect(readFieldText(field({ kind: 'number' }), 'abc')).toBe('invalid');
    expect(readFieldText(field({ kind: 'choice', options: ['a'] }), 'b')).toBe('invalid');
  });
});
