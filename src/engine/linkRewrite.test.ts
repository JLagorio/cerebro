import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import type { Entry } from './types';
import { conceptAnchors, movedPath, planRename, rewriteLinks } from './linkRewrite';
import { resolveLink, wikilinkSpans } from './wikilink';

const old = makeEntry({
  path: 'notes/old-name.md',
  title: 'Old title',
  properties: { key: 'FLD-8' },
});
const move = [{ from: old.path, to: 'notes/new-name.md' }];
const citer = (text: string, path = 'notes/citer.md') =>
  makeEntry({ path, outgoingLinks: wikilinkSpans(text).map((span) => span.target) });

describe('planRename and rewriteLinks', () => {
  it('rewrites stems, case, aliases, sections, spacing, frontmatter and lists, leaving every other byte', () => {
    const before =
      '\ufeff---\r\nrelated: "[[Old-Name]]"\r\nrefs:\r\n  - \'[[old-name|a label]]\'\r\n---\r\n# Citer\r\n[[  old-name  # Heading  | label ]]\r\nPlain old-name, [[dangling]], [[Old title]], [[FLD-8]].\r\n';
    const entry = citer(before);
    const plan = planRename([entry, old], move);
    expect(plan.collisions).toEqual([]);
    const result = rewriteLinks(before, plan.pages[0].changes);
    expect(result.count).toBe(3);
    expect(result.content).toBe(
      '\ufeff---\r\nrelated: "[[new-name]]"\r\nrefs:\r\n  - \'[[new-name|a label]]\'\r\n---\r\n# Citer\r\n[[  new-name  # Heading  | label ]]\r\nPlain old-name, [[dangling]], [[Old title]], [[FLD-8]].\r\n',
    );
  });

  it('keeps title and item-key links when a stem-only rename leaves them resolving', () => {
    const entry = citer('[[Old title]] [[FLD-8]]');
    expect(planRename([entry, old], move).pages).toEqual([]);
    const retitled = planRename([entry, old], move, [{ path: old.path, title: 'New title' }]);
    expect(rewriteLinks('[[Old title]] [[FLD-8]]', retitled.pages[0].changes).content).toBe(
      '[[new-name]] [[FLD-8]]',
    );
  });

  it('applies folder and main-file steps in order and reads retitles from original paths', () => {
    const steps = [
      { from: 'docs/old', to: 'docs/new' },
      { from: 'docs/new/old.md', to: 'docs/new/new.md' },
    ];
    const main = makeEntry({ path: 'docs/old/old.md', title: 'Before' });
    const child = makeEntry({ path: 'docs/old/child.md', project: main.path });
    const plan = planRename([main, child], steps, [{ path: main.path, title: 'After' }]);
    expect(plan.after.map(({ path, title, project }) => ({ path, title, project }))).toEqual([
      { path: 'docs/new/child.md', title: 'child', project: 'docs/new/new.md' },
      { path: 'docs/new/new.md', title: 'After', project: null },
    ]);
    expect(movedPath('docs/older/x.md', steps)).toBe('docs/older/x.md');
  });

  it('keeps stem links on a folder move and repoints project-folder links', () => {
    const project = makeEntry({ path: 'projects/atlas/project.md', title: 'Atlas project' });
    const child = makeEntry({ path: 'projects/atlas/tasks.md' });
    const content = '[[atlas]] [[tasks]] [[project]]';
    const plan = planRename(
      [project, child, citer(content)],
      [{ from: 'projects/atlas', to: 'projects/meridian' }],
    );
    expect(plan.collisions).toEqual([]);
    expect(rewriteLinks(content, plan.pages[0].changes)).toEqual({
      content: '[[meridian]] [[tasks]] [[project]]',
      count: 1,
    });
  });

  it('resolves the whole target before its fragment, and preserves empty fragments too', () => {
    const hashTitle = makeEntry({ path: 'notes/csharp.md', title: 'C# notes' });
    const content = '[[C# notes]] [[old-name#]] [[old-name # Heading#More]]';
    const plan = planRename([hashTitle, old, citer(content)], move, [
      { path: hashTitle.path, title: 'C sharp' },
    ]);
    expect(rewriteLinks(content, plan.pages[0].changes).content).toBe(
      '[[csharp]] [[new-name#]] [[new-name # Heading#More]]',
    );
  });

  it('repairs self links at the pre-move source path', () => {
    const self = { ...old, outgoingLinks: ['old-name'] };
    const plan = planRename([self], move);
    expect(plan.pages[0].entry.path).toBe(old.path);
    expect(rewriteLinks('[[old-name]]', plan.pages[0].changes).content).toBe('[[new-name]]');
  });

  it('leaves dangling and malformed links alone', () => {
    const content = '[[missing]] [[nested[[old-name]] [[old-name';
    expect(planRename([old, citer(content)], move).pages).toEqual([]);
    expect(rewriteLinks(content, [])).toEqual({ content, count: 0 });
  });

  it('refuses a required stem held by another page and names that holder', () => {
    const holder = makeEntry({ path: 'a/new-name.md', title: 'Already here' });
    const plan = planRename([holder, old, citer('[[old-name]]')], move);
    expect(plan.collisions).toHaveLength(1);
    expect(plan.collisions[0]).toMatchObject({ name: 'new-name', holder: { path: holder.path } });
    expect(planRename([holder, old], move).collisions).toEqual([]);
  });

  it.each(['bad[stem', 'bad|stem', 'bad\\stem', 'bad"stem', "bad'stem", 'bad\nstem'])(
    'refuses unsafe required name %j',
    (name) => {
      const plan = planRename(
        [old, citer('[[old-name]]')],
        [{ from: old.path, to: `notes/${name}.md` }],
      );
      expect(plan.collisions).toEqual([{ name, holder: null }]);
    },
  );

  it('catches a new stem stealing a link from an unmoved title match', () => {
    const target = makeEntry({ path: 'notes/other.md', title: 'new-name' });
    const content = '[[new-name]]';
    const plan = planRename([old, target, citer(content)], move);
    expect(plan.collisions).toEqual([]);
    expect(rewriteLinks(content, plan.pages[0].changes).content).toBe('[[other]]');
  });

  it('detects duplicate stem resolution changing when a folder move changes path order', () => {
    const first = makeEntry({ path: 'a/same.md' });
    const second = makeEntry({ path: 'b/same.md' });
    const plan = planRename([first, second, citer('[[same]]')], [{ from: 'a', to: 'z' }]);
    expect(plan.collisions).toEqual([
      { name: 'same', holder: expect.objectContaining({ path: second.path }) },
    ]);
  });

  it('refuses a rewritten section that another whole-title match would steal', () => {
    const holder = makeEntry({ path: 'notes/other.md', title: 'new-name#Heading' });
    const plan = planRename([old, holder, citer('[[old-name#Heading]]')], move);
    expect(plan.collisions[0].holder?.path).toBe(holder.path);
  });

  it('keeps source resources as warnings, including absolute-vault and dot-relative spellings', () => {
    const source = makeEntry({
      path: 'knowledge/systems/a.md',
      properties: {
        sources: [
          { resource: '/notes/old-name.md' },
          { resource: './notes/old-name.md' },
          { resource: 'https://example.test/old-name.md' },
        ],
      } as unknown as Entry['properties'],
    });
    const plan = planRename([old, source], move);
    expect(plan.sources.map(({ resource, to }) => ({ resource, to }))).toEqual([
      { resource: '/notes/old-name.md', to: 'notes/new-name.md' },
      { resource: './notes/old-name.md', to: 'notes/new-name.md' },
    ]);
    expect(plan.pages).toEqual([]);
  });

  it('separates concept anchors from links it must refuse to rewrite', () => {
    const concept = makeEntry({
      path: 'Knowledge/systems/a.md',
      relationships: { about: ['old-name'], related: ['old-name'] },
      outgoingLinks: ['old-name'],
    });
    const plan = planRename([old, concept], move);
    expect(plan.pages).toEqual([]);
    expect(plan.concepts[0]).toMatchObject({
      anchors: ['new-name'],
      anchorCount: 1,
      refusedCount: 2,
    });
    const onlyBody = makeEntry({ path: 'knowledge/systems/body.md', outgoingLinks: ['old-name'] });
    expect(
      planRename([old, onlyBody], [{ from: old.path, to: 'notes/bad|name.md' }]).collisions,
    ).toEqual([]);
  });

  it('a rename leaves every link pointing where it pointed', () => {
    const other = makeEntry({ path: 'notes/other.md', title: 'new-name' });
    const content =
      '[[old-name]] [[old-name#A|one]] [[Old title]] [[FLD-8]] [[new-name]] [[unknown]]';
    const entries = [old, other, citer(content)];
    const plan = planRename(entries, move, [{ path: old.path, title: 'New title' }]);
    expect(plan.collisions).toEqual([]);
    const result = rewriteLinks(content, plan.pages[0].changes);
    const original = wikilinkSpans(content);
    const rewritten = wikilinkSpans(result.content);
    for (let i = 0; i < original.length; i += 1) {
      const before = resolveLink(original[i].target, entries);
      const after = resolveLink(rewritten[i].target, plan.after);
      expect(after?.entry.path ?? null).toBe(
        before === null ? null : movedPath(before.entry.path, move),
      );
      expect(after?.section ?? null).toBe(before?.section ?? null);
    }
  });
});

describe('conceptAnchors', () => {
  const changes = [{ target: 'old-name', replacement: 'new-name', pageEnd: 8 }];

  it('keeps a scalar and its alias, returning no body writes', () => {
    const raw = '---\nabout: "[[ old-name | Name ]]"\n---\n[[old-name]]';
    expect(conceptAnchors(raw, changes)).toEqual({
      about: '[[ new-name | Name ]]',
      count: 1,
      linkCount: 1,
    });
    expect(raw).toContain('\n[[old-name]]');
  });

  it('keeps list shape and unchanged anchors, including plain strings', () => {
    const raw = '---\nabout:\n  - "[[old-name]]"\n  - " old-name "\n  - "[[unmoved]]"\n---\nBody';
    expect(conceptAnchors(raw, changes)).toEqual({
      about: ['[[new-name]]', ' new-name ', '[[unmoved]]'],
      count: 2,
      linkCount: 1,
    });
  });

  it.each([
    'Body',
    '---\nabout: [broken\n---\nBody',
    '---\nabout: 1\n---\n',
    '---\nabout: [old-name, 2]\n---\n',
    '---\nabout: "[[unmoved]]"\n---\n',
    '---\n- old-name\n---\n',
  ])('leaves absent, unreadable, unsupported or unchanged about alone: %j', (raw) => {
    expect(conceptAnchors(raw, changes)).toBeNull();
  });
});

it('a board citing the page never enters the note batch and does not create a writable collision', () => {
  const board = citer('[[old-name]] [[Old title]]', 'boards/plan.canvas');
  const plan = planRename([old, board], move);
  expect(plan.pages).toEqual([]);
  expect(plan.concepts).toEqual([]);
  expect(plan.sources).toHaveLength(1);
  expect(plan.sources[0]).toMatchObject({
    entry: { path: board.path },
    resource: 'old-name',
    to: 'new-name',
    board: true,
  });
  const holder = makeEntry({ path: 'a/new-name.md', title: 'Another' });
  expect(planRename([holder, old, board], move).collisions).toEqual([]);
});
it('renaming a whiteboard updates the filename-derived title for normal link repair', () => {
  const board = makeEntry({
    path: 'boards/old-name.canvas',
    filename: 'old-name.canvas',
    title: 'Old name',
  });
  const page = citer('[[Old name]]');
  const plan = planRename([board, page], [{ from: board.path, to: 'boards/new-name.canvas' }]);
  expect(plan.after.find((entry) => entry.path.endsWith('.canvas'))?.title).toBe('New name');
  expect(plan.pages[0].changes[0].replacement).toBe('new-name.canvas');
});
