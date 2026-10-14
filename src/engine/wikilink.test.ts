import { describe, expect, it } from 'vitest';
import { formatWikilink, freshStem, parseWikilinks, resolveTarget } from './wikilink';
import { makeEntry } from './testHelpers';

describe('parseWikilinks', () => {
  const cases: [string, unknown, string[] | null][] = [
    ['single wikilink string', '[[fld-7]]', ['fld-7']],
    ['piped alias keeps the target only', '[[ana-marte|Ana]]', ['ana-marte']],
    ['multiple wikilinks in one string', '[[a]] blocks [[b]]', ['a', 'b']],
    ['array of wikilink strings', ['[[a]]', '[[b]]'], ['a', 'b']],
    ['array with piped aliases', ['[[a|A]]', '[[b|B]]'], ['a', 'b']],
    ['mixed array keeps only wikilink targets', ['[[a]]', 'plain'], ['a']],
    ['whitespace inside brackets is trimmed', '[[ flight-deck ]]', ['flight-deck']],
    ['plain string is not a wikilink', 'plain', null],
    ['number is not a wikilink', 42, null],
    ['boolean is not a wikilink', true, null],
    ['null is not a wikilink', null, null],
    ['array without wikilinks', ['x', 'y'], null],
    ['object is not a wikilink', { a: 1 }, null],
    ['empty brackets are not a wikilink', '[[]]', null],
    // Parity with mockParse.extractWikilinks / entry.rs collect_targets:
    ['targets containing brackets are rejected', '[[a[b]]', null],
    ['nested arrays are scanned recursively', [['[[a]]'], '[[b]]'], ['a', 'b']],
  ];

  it.each(cases)('%s', (_name, value, expected) => {
    expect(parseWikilinks(value)).toEqual(expected);
  });
});

describe('formatWikilink', () => {
  it('wraps the target in double brackets', () => {
    expect(formatWikilink('fld-7')).toBe('[[fld-7]]');
  });
});

describe('resolveTarget', () => {
  const ana = makeEntry({
    path: 'people/ana-marte.md',
    filename: 'ana-marte.md',
    title: 'Ana Marte',
  });
  const deck = makeEntry({
    path: 'projects/flight-deck.md',
    filename: 'flight-deck.md',
    title: 'Flight deck',
  });
  // decoy: its *title* collides with deck's filename stem — stem match must win
  const decoy = makeEntry({
    path: 'items/misc.md',
    filename: 'misc.md',
    title: 'flight-deck',
  });
  const entries = [decoy, ana, deck];

  it('matches by filename stem, case-insensitive', () => {
    expect(resolveTarget('Flight-Deck', entries)).toBe(deck);
  });

  it('prefers a stem match over a title match regardless of array order', () => {
    expect(resolveTarget('flight-deck', entries)).toBe(deck);
  });

  it('falls back to exact title match, case-insensitive', () => {
    expect(resolveTarget('ana marte', entries)).toBe(ana);
  });

  it('trims the target before matching', () => {
    expect(resolveTarget('  ana-marte  ', entries)).toBe(ana);
  });

  it('returns null when nothing matches', () => {
    expect(resolveTarget('nobody', entries)).toBeNull();
  });

  // A project IS its folder (vault format v2), and every project's file is
  // named project.md — so without this pass `[[atlas]]` dangles and every
  // link into a project in the vault silently resolves to nothing.
  describe('project folders', () => {
    const atlas = makeEntry({
      path: 'projects/atlas/project.md',
      filename: 'project.md',
      folder: 'projects/atlas',
      title: 'Atlas rollout',
      type: 'Project',
    });

    it('matches a project by its folder name', () => {
      expect(resolveTarget('atlas', [atlas])).toBe(atlas);
      expect(resolveTarget('ATLAS', [atlas])).toBe(atlas);
    });

    it('still matches a project by title', () => {
      expect(resolveTarget('Atlas rollout', [atlas])).toBe(atlas);
    });

    it('lets a real stem match win over a project folder of the same name', () => {
      const note = makeEntry({ path: 'docs/atlas.md', filename: 'atlas.md', title: 'Atlas notes' });
      expect(resolveTarget('atlas', [atlas, note])).toBe(note);
    });

    it('does not treat an ordinary file as its folder', () => {
      const item = makeEntry({
        path: 'projects/atlas/items/syn-1.md',
        filename: 'syn-1.md',
        folder: 'projects/atlas/items',
        title: 'Sync one',
      });
      expect(resolveTarget('items', [item])).toBeNull();
    });
  });
});

/**
 * The stem a page made from the link menu gets (M55.7). Vault-wide, because
 * resolveTarget's stem pass is: a stem unique only in its folder could send
 * the new link to an older page.
 */
describe('freshStem', () => {
  const page = (path: string, title = 'Something else') =>
    makeEntry({
      path,
      filename: path.slice(path.lastIndexOf('/') + 1),
      folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      title,
    });

  it('slugs the title', () => {
    expect(freshStem('Launch notes', [page('notes/other.md')])).toBe('launch-notes');
  });

  it('counts a page in another folder as taken', () => {
    expect(freshStem('Launch notes', [page('delivery/launch-notes.md')])).toBe('launch-notes-2');
  });

  it('matches stems case-insensitively, as links do', () => {
    expect(freshStem('Launch notes', [page('Launch-Notes.md')])).toBe('launch-notes-2');
  });

  it('counts on past every suffix already taken', () => {
    const taken = [page('launch-notes.md'), page('archive/launch-notes-2.md')];
    expect(freshStem('Launch notes', taken)).toBe('launch-notes-3');
  });

  it('falls back to page when nothing of the title survives the slug', () => {
    expect(freshStem('\u{1F680}', [])).toBe('page');
    expect(freshStem('\u{1F680}', [page('page.md')])).toBe('page-2');
  });

  it('does not count a diagram of the same name, whose stem keeps its .mmd', () => {
    expect(freshStem('Launch notes', [page('diagrams/launch-notes.mmd')])).toBe('launch-notes');
  });

  // A stem outranks a project folder and a title in resolveTarget, so one
  // equal to either would take over the links that already reach them.
  it('steps around a project folder or a title that already answers to the stem', () => {
    expect(freshStem('Atlas', [page('projects/atlas/project.md', 'Atlas rollout')])).toBe(
      'atlas-2',
    );
    expect(freshStem('Launch notes', [page('notes/ln.md', 'launch-notes')])).toBe('launch-notes-2');
  });
});
