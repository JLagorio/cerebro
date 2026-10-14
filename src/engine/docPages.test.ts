import { describe, expect, it } from 'vitest';
import noteTargets from '../../src-tauri/fixtures/note-targets.json';
import {
  canHaveSubPages,
  childPagesOf,
  crumbTrail,
  descendantPageCount,
  docFolderPathFor,
  docPagesFor,
  folderNote,
  growPlan,
  isDocFolder,
  isFolderNote,
  isHiddenFolderName,
  nestPlan,
  subPageFolder,
} from './docPages';
import type { Entry } from './types';

const entry = (path: string, partial: Partial<Entry> = {}): Entry => ({
  path,
  filename: path.split('/').pop() ?? path,
  folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  project: null,
  title: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
  type: null,
  properties: {},
  relationships: {},
  outgoingLinks: [],
  snippet: '',
  createdAt: '2026-07-01T00:00:00Z',
  modifiedAt: '2026-07-01T00:00:00Z',
  parseError: null,
  hash: null,
  ...partial,
});

const VAULT = [
  entry('notes/josef-1-1/josef-1-1.md', { createdAt: '2026-07-01T00:00:00Z' }),
  entry('notes/josef-1-1/agenda.md', { createdAt: '2026-07-03T00:00:00Z' }),
  entry('notes/josef-1-1/history.md', { createdAt: '2026-07-02T00:00:00Z' }),
  entry('notes/loose.md'),
  entry('projects/alpha/project.md'),
  entry('projects/alpha/spec.md'),
];

describe('docPages (folder-note pattern)', () => {
  it('folderNote finds the note matching its folder name', () => {
    expect(folderNote('notes/josef-1-1', VAULT)?.path).toBe('notes/josef-1-1/josef-1-1.md');
    expect(folderNote('notes', VAULT)).toBeNull();
    expect(folderNote('', VAULT)).toBeNull();
  });

  it('docPagesFor returns the page first, then its sub-pages by creation', () => {
    const pages = docPagesFor(VAULT[1], VAULT)!; // asked from a sub-page
    expect(pages.folder).toBe('notes/josef-1-1');
    expect(pages.main.path).toBe('notes/josef-1-1/josef-1-1.md');
    expect(pages.pages.map((p) => p.path)).toEqual([
      'notes/josef-1-1/josef-1-1.md',
      'notes/josef-1-1/history.md',
      'notes/josef-1-1/agenda.md',
    ]);
  });

  it('plain files and project folders have no Pages', () => {
    expect(docPagesFor(VAULT[3], VAULT)).toBeNull();
    expect(docPagesFor(VAULT[5], VAULT)).toBeNull(); // alpha/ holds project.md, not alpha.md
    expect(isDocFolder('projects/alpha', VAULT)).toBe(false);
    expect(isDocFolder('notes/josef-1-1', VAULT)).toBe(true);
  });

  it('docFolderPathFor names the folder a doc would grow into', () => {
    expect(docFolderPathFor(entry('notes/loose.md'))).toBe('notes/loose');
    expect(docFolderPathFor(entry('root.md'))).toBe('root');
  });

  it('isFolderNote and subPageFolder', () => {
    expect(isFolderNote(VAULT[0])).toBe(true);
    expect(isFolderNote(VAULT[1])).toBe(false);
    expect(isFolderNote(entry('root.md'))).toBe(false);
    expect(subPageFolder(VAULT[0])).toBe('notes/josef-1-1');
    expect(subPageFolder(VAULT[3])).toBe('notes/loose');
  });
});

// M55.13 — sub-pages: a page's children live in its folder, and a child that
// grew a folder of its own stays a child, through its folder note.
describe('sub-pages (M55.13)', () => {
  const PLAN = [
    entry('plan/plan.md', { createdAt: '2026-07-01T00:00:00Z' }),
    entry('plan/b-notes.md', { createdAt: '2026-07-03T00:00:00Z', title: 'Notes' }),
    entry('plan/a-goals.md', { createdAt: '2026-07-03T00:00:00Z', title: 'Goals' }),
    entry('plan/rollout/rollout.md', { createdAt: '2026-07-02T00:00:00Z', title: 'Rollout' }),
    entry('plan/rollout/checklist.md', { createdAt: '2026-07-02T00:00:00Z' }),
    entry('plan/rollout/deep/deep.md'),
    entry('plan/task.md', { type: 'Work item' }),
    entry('plan/loose-folder/stray.md'),
    entry('plan/project.md'),
  ];

  it('childPagesOf lists direct docs and grown children, leaves out records, and sorts', () => {
    expect(childPagesOf(PLAN[0], PLAN).map((p) => p.path)).toEqual([
      'plan/rollout/rollout.md',
      'plan/a-goals.md',
      'plan/b-notes.md',
    ]);
    // A grown child lists its own, grandchildren included through their notes.
    expect(childPagesOf(PLAN[3], PLAN).map((p) => p.path)).toEqual([
      'plan/rollout/deep/deep.md',
      'plan/rollout/checklist.md',
    ]);
    // A plain page beside a same-name folder does not adopt its pages (Q27).
    const beside = [entry('notes/plan.md'), entry('notes/plan/other.md')];
    expect(childPagesOf(beside[0], beside)).toEqual([]);
  });

  it('docPagesFor lists a grown child', () => {
    const pages = docPagesFor(PLAN[1], PLAN)!;
    expect(pages.pages.map((p) => p.path)).toContain('plan/rollout/rollout.md');
  });

  it('descendantPageCount counts grandchildren, never the page itself or records', () => {
    expect(descendantPageCount('plan', PLAN)).toBe(7);
    expect(descendantPageCount('plan/rollout', PLAN)).toBe(2);
  });

  it('canHaveSubPages refuses knowledge, templates, agents, skills, Types, Collections, .mmd', () => {
    expect(canHaveSubPages(entry('notes/loose.md'))).toBe(true);
    expect(canHaveSubPages(entry('records/task.md', { type: 'Work item' }))).toBe(true);
    expect(canHaveSubPages(entry('knowledge/metrics/churn.md'))).toBe(false);
    expect(canHaveSubPages(entry('templates/meeting.md'))).toBe(false);
    expect(canHaveSubPages(entry('records/agents/scout.md', { type: 'Agent' }))).toBe(false);
    expect(canHaveSubPages(entry('skills/triage.md', { type: 'Skill' }))).toBe(false);
    expect(canHaveSubPages(entry('types/work-item.md', { type: 'Type' }))).toBe(false);
    expect(canHaveSubPages(entry('delivery/delivery.md', { type: 'Collection' }))).toBe(false);
    expect(canHaveSubPages(entry('projects/alpha/project.md'))).toBe(false);
    expect(canHaveSubPages(entry('diagrams/flow.mmd'))).toBe(false);
  });

  describe('growPlan', () => {
    it('grows a file into a folder of its own by rename', () => {
      expect(growPlan(entry('notes/loose.md'), [], ['notes'])).toEqual({
        folder: 'notes/loose',
        move: { from: 'notes/loose.md', to: 'notes/loose/loose.md' },
      });
    });

    it('leaves a folder note where it is', () => {
      expect(growPlan(PLAN[0], PLAN, ['plan'])).toEqual({ folder: 'plan', move: null });
    });

    it('refuses a folder of that name already beside the page, empty or not', () => {
      const page = entry('notes/plan.md');
      const empty = growPlan(page, [page], ['notes', 'notes/plan']);
      expect(empty).toEqual({ refused: expect.stringContaining('notes/plan/') });
      const held = growPlan(page, [page, entry('notes/plan/x.md')], ['notes']);
      expect('refused' in held).toBe(true);
    });

    it('refuses views, attachments, templates and knowledge', () => {
      for (const path of ['views.md', 'notes/attachments.md', 'templates.md']) {
        expect('refused' in growPlan(entry(path), [], []), path).toBe(true);
      }
      expect('refused' in growPlan(entry('templates/meeting.md'), [], [])).toBe(true);
      expect('refused' in growPlan(entry('knowledge/metrics/churn.md'), [], [])).toBe(true);
      // Names the scanner lists stay growable.
      for (const path of ['VIEWS.md', 'Attachments.md', 'views..md']) {
        expect('folder' in growPlan(entry(path), [], []), path).toBe(true);
      }
    });
  });

  /**
   * The third copy of the scanner's skip rule (scan.rs `is_skipped_dir`, the
   * mock's `isSkippedDir`) replays the shared note targets: a folder in a
   * markdown note's path the writers refuse as "not a note" is one this
   * predicate calls hidden, and a path that lands has none.
   */
  it('isHiddenFolderName agrees with the note targets the writers replay', () => {
    const cases = (noteTargets.cases as { door: string; path?: string; refused?: string }[])
      .filter((c) => c.door === 'save_note' && c.path?.endsWith('.md') === true)
      .filter((c) => c.refused === undefined || c.refused === 'not a note');
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) {
      const names = (c.path as string).split('/');
      const file = names.pop() as string;
      const hiddenFile = isHiddenFolderName(file) && file.replace(/\.md$/, '') !== '';
      const hiddenFolder = names.some(isHiddenFolderName);
      expect(hiddenFolder || hiddenFile, c.path).toBe(c.refused !== undefined);
    }
    expect(isHiddenFolderName('views')).toBe(true);
    expect(isHiddenFolderName('attachments')).toBe(true);
    expect(isHiddenFolderName('VIEWS')).toBe(false);
    expect(isHiddenFolderName('Attachments')).toBe(false);
    expect(isHiddenFolderName('views.')).toBe(false);
  });

  describe('nestPlan', () => {
    const TREE = [
      entry('notes/target.md', { title: 'Target' }),
      entry('notes/src.md'),
      entry('notes/doc/doc.md'),
      entry('notes/doc/child.md'),
      entry('other/target.md'),
    ];
    const FOLDERS = ['notes', 'notes/doc', 'other'];

    it('grows the target, then moves the source into it', () => {
      expect(nestPlan('notes/src.md', TREE[0], TREE, FOLDERS)).toEqual({
        folder: 'notes/target',
        moves: [
          { from: 'notes/target.md', to: 'notes/target/target.md' },
          { from: 'notes/src.md', to: 'notes/target/src.md' },
        ],
      });
    });

    it('moves a folder note with its folder, so its sub-pages come along', () => {
      const plan = nestPlan('notes/doc/doc.md', TREE[0], TREE, FOLDERS);
      expect(plan).toMatchObject({ moves: [{}, { from: 'notes/doc', to: 'notes/target/doc' }] });
    });

    it('refuses self, its own subtree, an existing name and an existing sub-page', () => {
      expect('refused' in nestPlan('notes/target.md', TREE[0], TREE, FOLDERS)).toBe(true);
      // A doc dropped onto its own sub-page.
      expect('refused' in nestPlan('notes/doc', TREE[3], TREE, FOLDERS)).toBe(true);
      // Onto its own folder note.
      expect('refused' in nestPlan('notes/doc', TREE[2], TREE, FOLDERS)).toBe(true);
      // The grown page's own name.
      expect('refused' in nestPlan('other/target.md', TREE[0], TREE, FOLDERS)).toBe(true);
      // Already a sub-page there.
      expect('refused' in nestPlan('notes/doc/child.md', TREE[2], TREE, FOLDERS)).toBe(true);
      // A name the folder already holds.
      const held = [...TREE, entry('notes/doc/src.md')];
      expect('refused' in nestPlan('notes/src.md', TREE[2], held, FOLDERS)).toBe(true);
    });
  });

  it('crumbTrail renders ancestor pages as pages and plain folders as folders', () => {
    expect(crumbTrail(PLAN[4], PLAN)).toEqual([
      { kind: 'page', entry: PLAN[0] },
      { kind: 'page', entry: PLAN[3] },
    ]);
    // A folder note's own folder is the page itself.
    expect(crumbTrail(PLAN[3], PLAN)).toEqual([{ kind: 'page', entry: PLAN[0] }]);
    expect(crumbTrail(PLAN[7], PLAN)).toEqual([
      { kind: 'page', entry: PLAN[0] },
      { kind: 'folder', label: 'Loose Folder' },
    ]);
    expect(crumbTrail(entry('root.md'), PLAN)).toEqual([]);
  });
});
