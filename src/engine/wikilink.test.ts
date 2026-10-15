import { describe, expect, it } from 'vitest';
import TARGET_CASES from '../../src-tauri/fixtures/wikilink-targets.json';
import type { Entry } from './types';
import {
  buildTargetIndex,
  formatWikilink,
  freshStem,
  itemKeyOf,
  linkTargetOf,
  linkTargetOfPath,
  linkTargetsFor,
  parseLinkTarget,
  parseWikilinks,
  resolveLink,
  resolveTarget,
  targetIndexFor,
  wikilinkSpans,
} from './wikilink';
import { makeEntry } from './testHelpers';

describe('wikilinkSpans', () => {
  it('names exact source offsets without absorbing spacing, sections or an alias', () => {
    const text = 'before [[  page # Heading  | label ]] after [[next]]';
    const spans = wikilinkSpans(text);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      '[[  page # Heading  | label ]]',
      '[[next]]',
    ]);
    expect(spans.map((span) => text.slice(span.targetStart, span.targetEnd))).toEqual([
      'page # Heading',
      'next',
    ]);
    expect(spans.map((span) => span.target)).toEqual(['page # Heading', 'next']);
  });

  it.each([
    ['[[]] [[ |alias]] [[ok]]', ['ok']],
    ['[[outer[[inner]] [[after]]', ['after']],
    ['[[a[b]] [[x]y]] [[last]]', ['last']],
    ['[[first|a|b]] and [[unfinished', ['first']],
    ['[[\t\u00a0page\n]]', ['page']],
  ])('keeps the target scanner semantics for %j', (text, targets) => {
    expect(wikilinkSpans(text).map((span) => span.target)).toEqual(targets);
    expect(parseWikilinks(text)).toEqual(targets.length === 0 ? null : targets);
  });
});

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

/** A page from its vault path, filename and folder read off it, and its `key:` when given. */
const pageAt = (path: string, title: string, key?: unknown) =>
  makeEntry({
    path,
    filename: path.slice(path.lastIndexOf('/') + 1),
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    title,
    ...(key === undefined ? {} : { properties: { key } as Entry['properties'] }),
  });

/** The shared golden's corpus, each entry's optional key as its `properties.key`. */
const goldenCorpus = (): Entry[] =>
  TARGET_CASES.entries.map((e) => pageAt(e.path, e.title, 'key' in e ? e.key : undefined));

/** `items` behind a Proxy that counts its index reads, so a test can bound the passes. */
function counted<T extends object>(items: T[]): { array: T[]; reads: () => number } {
  let reads = 0;
  const array = new Proxy(items, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { array, reads: () => reads };
}

describe('parseLinkTarget', () => {
  const cases: [string, string, string | null][] = [
    ['notes', 'notes', null],
    ['notes#Risks', 'notes', 'Risks'],
    [' notes # Risks ', 'notes', 'Risks'],
    ['notes#', 'notes', null],
    ['notes#  ', 'notes', null],
    ['notes#A#B', 'notes', 'A#B'],
    ['#Risks', '', 'Risks'],
    ['#', '', null],
    ['C# notes', 'C', 'notes'],
  ];
  it.each(cases)('%j is the page %j and the section %j', (target, page, section) => {
    expect(parseLinkTarget(target)).toEqual({ page, section });
  });
});

/** Section links (M55.8): the whole target first, then the page before the first `#`. */
describe('resolveLink', () => {
  const notes = pageAt('docs/notes.md', 'Notes');
  const sharp = pageAt('docs/c-sharp.md', 'C# notes');
  const c = pageAt('docs/c.md', 'C');
  const entries = [notes, sharp, c];

  it('resolves the page and keeps the section', () => {
    expect(resolveLink('notes#Risks', entries)).toEqual({ entry: notes, section: 'Risks' });
    expect(resolveLink('Notes # Open questions ', entries)).toEqual({
      entry: notes,
      section: 'Open questions',
    });
  });

  it('reads a link with no section as the page alone', () => {
    expect(resolveLink('notes', entries)).toEqual({ entry: notes, section: null });
  });

  it('reads a whole target that names a page first, so C# notes stays a title link', () => {
    expect(resolveLink('C# notes', entries)).toEqual({ entry: sharp, section: null });
  });

  it('resolves nothing with no page half, or a page half that names nothing', () => {
    expect(resolveLink('#Risks', entries)).toBeNull();
    expect(resolveLink('nothing#Risks', entries)).toBeNull();
  });

  it('gives resolveTarget the page, so every reader of a link reads a section link', () => {
    expect(resolveTarget('notes#Risks', entries)).toBe(notes);
    expect(resolveTarget('C# notes', entries)).toBe(sharp);
  });

  // The same cases link.rs replays, so the twins answer alike.
  it('replays the shared target cases', () => {
    expect(TARGET_CASES.format).toBe(1);
    const corpus = goldenCorpus();
    expect(TARGET_CASES.cases.length).toBeGreaterThan(0);
    for (const { target, path, section } of TARGET_CASES.cases) {
      const link = resolveLink(target, corpus);
      expect(
        link === null ? null : { path: link.entry.path, section: link.section },
        target,
      ).toEqual(path === null ? null : { path, section });
    }
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

/** Item keys (M60.9): PREFIX-N, ASCII-trimmed and lowercased, else null. */
describe('itemKeyOf', () => {
  const cases: [string, unknown, string | null][] = [
    ['a key', 'FLD-13', 'fld-13'],
    ['trimmed', ' fld-2 ', 'fld-2'],
    ['a prefix with dashes', 'MY-TEAM-12', 'my-team-12'],
    ['a zero-led number kept as written', 'FLD-01', 'fld-01'],
    ["a project's own prefix", 'FLD', null],
    ['no number', 'FLD-', null],
    ['an empty segment', 'FLD--3', null],
    ['a symbol in the prefix', 'C++-5', null],
    ['a letter in the tail', 'FLD-1a', null],
    ['a bare number string', '12', null],
    ['a number', 12, null],
    ['a list', ['FLD-13'], null],
    ['a non-ASCII space is not trimmed', ' FLD-13', null],
    ['no key', undefined, null],
  ];
  it.each(cases)('%s: %j gives %j', (_name, key, expected) => {
    expect(itemKeyOf(pageAt('records/x.md', 'X', key))).toBe(expected);
  });
});

describe('the item key pass', () => {
  const ship = pageAt('records/work/ship-docs.md', 'Ship docs', 'FLD-13');

  it('resolves a key after stem and folder and before title', () => {
    const stem = pageAt('items/fld-14.md', 'Item');
    const keyed = pageAt('records/a.md', 'A', 'FLD-14');
    const titled = pageAt('docs/n.md', 'FLD-15');
    const keyedTitle = pageAt('records/b.md', 'B', 'FLD-15');
    const entries = [ship, keyed, stem, titled, keyedTitle];
    expect(resolveTarget('FLD-13', entries)).toBe(ship);
    expect(resolveTarget('fld-14', entries)).toBe(stem);
    expect(resolveTarget('fld-15', entries)).toBe(keyedTitle);
    expect(resolveLink('fld-13#Notes', entries)).toEqual({ entry: ship, section: 'Notes' });
  });

  it('gives the earlier entry a tied key', () => {
    const second = pageAt('records/b.md', 'B', 'FLD-13');
    expect(resolveTarget('fld-13', [ship, second])).toBe(ship);
    expect(resolveTarget('fld-13', [second, ship])).toBe(second);
  });
});

/** The one inverse of the resolver (M60.9). */
describe('linkTargetOfPath and linkTargetOf', () => {
  it.each([
    ['notes/launch-notes.md', 'launch-notes'],
    ['launch-notes.md', 'launch-notes'],
    ['notes/archive/Launch-Notes.MD', 'Launch-Notes'],
    ['projects/atlas/project.md', 'atlas'],
    ['projects/Atlas/Project.md', 'Atlas'],
    ['project.md', 'project'],
    ['diagrams/flow.mmd', 'flow.mmd'],
    ['top.md', 'top'],
  ])('%s writes %s', (path, name) => {
    expect(linkTargetOfPath(path)).toBe(name);
  });

  it('round-trips every golden entry whose name is its own', () => {
    const corpus = goldenCorpus();
    const names = corpus.map((e) => linkTargetOf(e).toLowerCase());
    let checked = 0;
    corpus.forEach((entry, i) => {
      if (names.indexOf(names[i]) !== names.lastIndexOf(names[i])) return;
      expect(resolveTarget(linkTargetOf(entry), corpus), entry.path).toBe(entry);
      checked += 1;
    });
    expect(checked).toBe(corpus.length);
  });
});

describe('linkTargetsFor: a link that reaches the page it was written for', () => {
  const PLAN = pageAt('delivery/plan.md', 'The plan');
  const TICKET = pageAt('records/tickets/t-1.md', 'Fix the login');
  // The demo vault's shape: four meetings/kickoff.md files share one stem,
  // and `resolveTarget`'s stem pass gives `[[kickoff]]` to the first.
  const KICKOFFS = [
    pageAt('projects/field-app/meetings/kickoff.md', 'Field App kickoff'),
    pageAt('projects/sync/meetings/kickoff.md', 'Offline sync kickoff'),
  ];
  const ATLAS = pageAt('projects/atlas/project.md', 'Atlas');
  const ORBIT = pageAt('projects/orbit/project.md', 'Orbit');
  // Shares the stem with the first kickoff AND the title with the second.
  const IMPOSTOR = pageAt('notes/kickoff.md', 'Offline sync kickoff');
  const ALL = [...KICKOFFS, ATLAS, ORBIT, PLAN, TICKET];
  const of = (entry: Entry, entries: Entry[]) => linkTargetsFor(entries)(entry);

  it('links a page by its filename stem', () => {
    expect(of(PLAN, ALL)).toBe('plan');
    expect(of(TICKET, ALL)).toBe('t-1');
  });

  it('writes the stem when it is the page’s own, and the title when another page has it', () => {
    expect(of(KICKOFFS[0], ALL)).toBe('kickoff');
    expect(of(KICKOFFS[1], ALL)).toBe('Offline sync kickoff');
  });

  it('writes the item key before the title when the stem is taken', () => {
    const keyed = pageAt('projects/sync/meetings2/kickoff.md', 'Sync two', 'SYN-2');
    expect(of(keyed, [...ALL, keyed])).toBe('SYN-2');
  });

  it('writes a project by its folder, since every project is a project.md', () => {
    expect(of(ATLAS, ALL)).toBe('atlas');
    expect(of(ORBIT, ALL)).toBe('orbit');
    // A stem named like the folder takes it, so the project falls back.
    const atlasNote = pageAt('notes/atlas.md', 'Atlas notes');
    expect(of(ATLAS, [atlasNote, ...ALL])).toBe('project');
  });

  it('gives null when every name the page has reaches another page', () => {
    expect(of(IMPOSTOR, [...KICKOFFS, IMPOSTOR])).toBeNull();
  });

  it('refuses a name the scanners would read differently', () => {
    const piped = pageAt('a/x.md', 'A | B');
    expect(of(piped, [pageAt('b/x.md', 'x'), piped])).toBeNull();
  });

  it('points a section link at the page too', () => {
    const targetOf = linkTargetsFor(ALL);
    expect(targetOf(KICKOFFS[0], 'Agenda')).toBe('kickoff#Agenda');
    expect(targetOf(KICKOFFS[1], 'Agenda')).toBe('Offline sync kickoff#Agenda');
    // A title with a `#` reaches its page whole, but cut at its `#` it would not.
    const sharp = pageAt('b/plan.md', 'C# notes');
    const vault = [PLAN, sharp];
    expect(linkTargetsFor(vault)(sharp)).toBe('C# notes');
    expect(linkTargetsFor(vault)(sharp, 'Risks')).toBeNull();
  });

  it('every name it writes resolves back to its page', () => {
    const vault = [
      ...ALL,
      IMPOSTOR,
      pageAt('a/plan.md', 'kickoff'),
      pageAt('r/keyed.md', 'FLD-9', 'FLD-8'),
      pageAt('r/other.md', 'Other', 'FLD-9'),
      ...goldenCorpus(),
    ];
    const targetOf = linkTargetsFor(vault);
    for (const entry of vault) {
      const target = targetOf(entry);
      if (target !== null) expect(resolveTarget(target, vault)).toBe(entry);
      const section = targetOf(entry, 'Risks');
      if (section !== null)
        expect(resolveLink(section, vault)).toEqual({ entry, section: 'Risks' });
    }
  });
});

/** One index per entries array (M60.9), so a vault's worth of links resolves in one pass. */
describe('targetIndexFor', () => {
  const corpus = () => [pageAt('a/one.md', 'One'), pageAt('b/two.md', 'Two')];

  it('gives one array one index, and a new array a new one', () => {
    const entries = corpus();
    expect(targetIndexFor(entries)).toBe(targetIndexFor(entries));
    expect(targetIndexFor(corpus())).not.toBe(targetIndexFor(entries));
  });

  it('rebuilds when the array grows, so a pushed page resolves', () => {
    const entries = corpus();
    const before = targetIndexFor(entries);
    expect(resolveTarget('three', entries)).toBeNull();
    entries.push(pageAt('c/three.md', 'Three'));
    expect(targetIndexFor(entries)).not.toBe(before);
    expect(resolveTarget('three', entries)).toBe(entries[2]);
  });

  it('answers as a freshly built index does', () => {
    const entries = goldenCorpus();
    const fresh = buildTargetIndex(entries);
    for (const { target } of TARGET_CASES.cases) {
      expect(targetIndexFor(entries).resolveLink(target)).toEqual(fresh.resolveLink(target));
    }
  });

  it('resolves 1,000 targets with at most one read of the entries array', () => {
    const pages = Array.from({ length: 500 }, (_, i) => pageAt(`n/page-${i}.md`, `Page ${i}`));
    const { array, reads } = counted(pages);
    for (let i = 0; i < 1000; i += 1)
      resolveTarget(i % 2 === 0 ? `page-${i % 500}` : 'none', array);
    expect(reads()).toBeLessThanOrEqual(pages.length);
  });
});
