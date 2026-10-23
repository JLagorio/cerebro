import { describe, expect, it } from 'vitest';
import type { KnowledgeNote } from '@/agent/context';
import {
  PANEL_SOURCES_WORDS,
  pullRequestSources,
  turnKnowledge,
} from '@/agent/elements/panelSources';

/**
 * The panel's own sources (M91.14): a session's pull requests as links the
 * element checks, and the Knowledge a turn carries as pages the app opens,
 * counted by what stands and each saying where it stands.
 */

const note = (path: string, over: Partial<KnowledgeNote> = {}): KnowledgeNote => ({
  path: `knowledge/concepts/${path}`,
  title: path.replace(/\.md$/, ''),
  claim: 'A claim.',
  review: 'current',
  reviewedBy: 'human',
  about: 'projects/atlas/project.md',
  relation: 'about',
  ...over,
});

describe('a session’s pull requests', () => {
  it('names each as its repository writes it, in the order the session opened them', () => {
    expect(
      pullRequestSources([
        { number: 42, url: 'https://github.com/acme/app/pull/42', repository: 'acme/app' },
        { number: 7, url: 'https://github.com/acme/site/pull/7', repository: 'acme/site' },
      ]),
    ).toEqual([
      {
        kind: 'url',
        url: 'https://github.com/acme/app/pull/42',
        title: 'acme/app#42',
        via: 'text',
      },
      {
        kind: 'url',
        url: 'https://github.com/acme/site/pull/7',
        title: 'acme/site#7',
        via: 'text',
      },
    ]);
  });

  it('keeps an address as the record gave it, for the element to refuse as a link', () => {
    const [ref] = pullRequestSources([
      { number: 1, url: 'javascript:alert(1)', repository: 'acme/app' },
    ]);
    expect(ref).toMatchObject({ kind: 'url', url: 'javascript:alert(1)' });
  });

  it('says how many in words', () => {
    expect(PANEL_SOURCES_WORDS.pullRequests(1)).toBe('Opened 1 pull request');
    expect(PANEL_SOURCES_WORDS.pullRequests(3)).toBe('Opened 3 pull requests');
  });
});

describe('the Knowledge a turn carries', () => {
  it('counts what stands, and lists the replaced last, saying so', () => {
    const { count, rows } = turnKnowledge([
      note('old.md', { title: 'The offline window', supersededBy: 'knowledge/concepts/new.md' }),
      note('cutover.md', { title: 'Warehouse cutover' }),
      note('drain.md', { title: 'Drain time', review: 'unreviewed', reviewedBy: null }),
    ]);
    expect(count).toBe(2);
    expect(PANEL_SOURCES_WORDS.knowledge(count)).toBe('Knowledge · 2');
    expect(rows.map((row) => [row.ref.title, row.standing])).toEqual([
      ['Warehouse cutover', null],
      ['Drain time', '· unreviewed'],
      ['The offline window', '· replaced'],
    ]);
  });

  it('opens each as a page of this vault, never as an address', () => {
    const { rows } = turnKnowledge([note('cutover.md', { title: 'Warehouse cutover' })]);
    expect(rows[0].ref).toEqual({
      kind: 'vault',
      path: 'knowledge/concepts/cutover.md',
      title: 'Warehouse cutover',
      via: 'read',
    });
  });

  it('says a replaced concept is replaced however it was reviewed', () => {
    const { rows } = turnKnowledge([
      note('old.md', { review: 'unreviewed', supersededBy: 'knowledge/concepts/new.md' }),
    ]);
    expect(rows[0].standing).toBe(PANEL_SOURCES_WORDS.replaced);
  });

  it('reads any review short of current as unreviewed', () => {
    const { rows } = turnKnowledge([
      note('a.md', { review: 'predates_current' }),
      note('b.md', { review: 'disputed' }),
    ]);
    expect(rows.map((row) => row.standing)).toEqual(['· unreviewed', '· unreviewed']);
  });

  it('leaves an untitled concept to be named by its path', () => {
    expect(turnKnowledge([note('x.md', { title: '  ' })]).rows[0].ref.title).toBeUndefined();
  });

  it('counts nothing when the turn carries nothing, or only what was replaced', () => {
    expect(turnKnowledge([])).toEqual({ count: 0, rows: [] });
    const replaced = turnKnowledge([note('old.md', { supersededBy: 'knowledge/new.md' })]);
    expect(replaced.count).toBe(0);
    expect(replaced.rows).toHaveLength(1);
  });
});
