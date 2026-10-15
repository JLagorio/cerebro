// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { assigneeLabel, wikilinkLabel } from './chipLabels';
import {
  escapeRegExp,
  findHits,
  firstAtOrAfter,
  nextIndex,
  replacementPlan,
  type FindHit,
  type LabelOf,
} from './findMatches';
import { markdownToBlocks } from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';

/**
 * Find's matching (M59.6) on a headless editor with the app's schema, docs
 * read from markdown the way a page loads.
 */

const entry = (path: string, title: string): Entry => ({
  path,
  filename: path.split('/').pop() ?? path,
  folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  project: null,
  title,
  type: null,
  properties: {},
  relationships: {},
  outgoingLinks: [],
  snippet: '',
  createdAt: '2026-07-01T00:00:00Z',
  modifiedAt: '2026-07-01T00:00:00Z',
  parseError: null,
  hash: null,
});

const ENTRIES = [
  entry('knowledge/sync-error-rate.md', 'Sync error rate'),
  entry('notes/kickoff.md', 'Kickoff'),
  entry('people/ana.md', 'Ana Sync'),
];

const labelOf: LabelOf = (type, attrs) => {
  if (type === 'wikilink') {
    return wikilinkLabel(
      { target: String(attrs.target), alias: String(attrs.alias ?? '') },
      ENTRIES,
    );
  }
  if (type === 'assignee') return assigneeLabel({ target: String(attrs.target) }, ENTRIES);
  return null;
};

let editor: CerebroEditor;

beforeEach(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});

async function load(md: string) {
  editor.replaceBlocks(editor.document, await markdownToBlocks(editor, md));
  return editor.prosemirrorState.doc;
}

async function find(md: string, query: string): Promise<FindHit[]> {
  return findHits(await load(md), query, labelOf);
}

/** Each hit as the doc text it covers. */
const covered = (hits: FindHit[]) =>
  hits.map((h) => editor.prosemirrorState.doc.textBetween(h.from, h.to));

/** The id of the deepest block whose own content holds `word`. */
function idHolding(word: string): string | null {
  let found: string | null = null;
  const walk = (blocks: unknown[]) => {
    for (const raw of blocks) {
      const block = raw as { id: string; content?: unknown; children?: unknown[] };
      if (JSON.stringify(block.content ?? null).includes(word)) found = block.id;
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(editor.document);
  return found;
}

describe('findHits: matching', () => {
  it('is case-insensitive and numbers hits from 1 in document order', async () => {
    const hits = await find('Sync first, then sync again.\n', 'SYNC');
    expect(covered(hits)).toEqual(['Sync', 'sync']);
    expect(hits.map((h) => h.index)).toEqual([1, 2]);
    expect(hits[0].from).toBeLessThan(hits[1].from);
    expect(hits.map((h) => h.text)).toEqual(['Sync', 'sync']);
  });

  it('matches pattern characters literally', async () => {
    const md = 'Use .* sparingly; a+b is not aab; one ( opens.\n';
    expect(covered(await find(md, '.*'))).toEqual(['.*']);
    expect(covered(await find(md, 'a+b'))).toEqual(['a+b']);
    expect(covered(await find(md, '('))).toEqual(['(']);
  });

  it('folds case beyond ASCII', async () => {
    expect(covered(await find('Un été chaud.\n', 'ÉTÉ'))).toEqual(['été']);
    expect(covered(await find('Наша работа.\n', 'РАБОТА'))).toEqual(['работа']);
  });

  it('never overlaps two hits', async () => {
    expect(await find('aaaa\n', 'aa')).toHaveLength(2);
  });

  it('finds nothing for an empty query', async () => {
    expect(await find('Anything.\n', '')).toEqual([]);
  });
});

describe('escapeRegExp', () => {
  it('escapes exactly the pattern syntax characters and the slash', () => {
    expect(escapeRegExp('^$\\.*+?()[]{}|/')).toBe('\\^\\$\\\\\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\/');
  });

  it('leaves everything else alone, so the u flag accepts it', async () => {
    for (const plain of ['-', '#', ',', ' ', 'a-b', 'C# notes']) {
      expect(escapeRegExp(plain)).toBe(plain);
      expect(() => new RegExp(escapeRegExp(plain), 'giu')).not.toThrow();
    }
    const md = 'Dash - hash # comma , close ] brace } end.\n';
    for (const q of ['-', '#', ',', ']', '}', 'comma ,']) {
      expect(covered(await find(md, q))).toEqual([q]);
    }
    expect(await find(md, ' ')).toHaveLength(10);
  });
});

describe('findHits: boundaries', () => {
  it('never spans two paragraphs or a hard break', async () => {
    expect(await find('end of one\n\nsync begins\n', 'one sync')).toEqual([]);
    expect(await find('line one\\\nsync two\n', 'one sync')).toEqual([]);
    expect(await find('line one\\\nsync two\n', 'sync')).toHaveLength(1);
  });

  it('finds one hit across two differently marked text nodes', async () => {
    const hits = await find('Say **hel**lo.\n', 'hello');
    expect(hits).toHaveLength(1);
    expect(covered(hits)).toEqual(['hello']);
  });

  it('gives every hit the block it sits in, however deep', async () => {
    const md = [
      '# alpha heading',
      '',
      '```',
      'bravo code',
      '```',
      '',
      '| Who | What |',
      '| --- | --- |',
      '| charlie | cell |',
      '',
      ':::columns',
      '::::column',
      'delta left',
      '::::',
      '::::column',
      'Right.',
      '::::',
      ':::',
      '',
      ':::toggle Open questions',
      'echo inside',
      ':::',
      '',
      ':::ai{prompt="What is foxtrot asking"}',
      'foxtrot answer',
      ':::',
      '',
    ].join('\n');
    await load(md);
    for (const word of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
      const hits = findHits(editor.prosemirrorState.doc, word, labelOf);
      expect(hits, word).toHaveLength(1);
      expect(hits[0].blockId, word).toBe(idHolding(word));
      expect(hits[0].blockId, word).not.toBeNull();
    }
    // The AI block's question is its own field, never searched: only the answer.
    const ai = findHits(editor.prosemirrorState.doc, 'foxtrot', labelOf);
    expect(covered(ai)).toEqual(['foxtrot']);
    expect(ai[0].blockId).toBe(idHolding('foxtrot answer'));
  });
});

describe('findHits: chips', () => {
  it('counts a link label as one hit over the whole chip', async () => {
    const hits = await find('See [[sync-error-rate]] and sync.\n', 'sync');
    expect(hits).toHaveLength(2);
    expect(hits[0].inLink).toBe(true);
    expect(hits[0].to - hits[0].from).toBe(1);
    expect(editor.prosemirrorState.doc.nodeAt(hits[0].from)?.type.name).toBe('wikilink');
    expect(hits[1].inLink).toBe(false);
  });

  it('counts a person label too', async () => {
    const hits = await find('- [ ] Ship it @[[ana]]\n', 'sync');
    expect(hits.map((h) => h.inLink)).toEqual([true]);
  });

  it('never matches a date or a citation badge', async () => {
    expect(await find('Due 📅 2026-10-20 here.\n', '2026')).toEqual([]);
    expect(await find('A claim.[^src]\n\n[^src]: A source.\n', 'src')).toEqual([]);
  });

  it('never spans text and a chip', async () => {
    expect(await find('I see [[kickoff]] today.\n', 'see kick')).toEqual([]);
    expect(await find('I see [[kickoff]] today.\n', 'kick')).toHaveLength(1);
  });
});

describe('helpers', () => {
  const hit = (index: number, from: number, inLink = false, text = 'x'): FindHit => ({
    index,
    from,
    to: from + 1,
    blockId: null,
    inLink,
    text,
  });

  it('nextIndex wraps both ways', () => {
    expect(nextIndex(1, 3, 1)).toBe(2);
    expect(nextIndex(3, 3, 1)).toBe(1);
    expect(nextIndex(1, 3, -1)).toBe(3);
    expect(nextIndex(2, 3, -1)).toBe(1);
    expect(nextIndex(0, 3, 1)).toBe(1);
    expect(nextIndex(1, 0, 1)).toBe(0);
  });

  it('firstAtOrAfter finds the next hit, wrapping to the first', () => {
    const hits = [hit(1, 5), hit(2, 10), hit(3, 20)];
    expect(firstAtOrAfter(hits, 0)).toBe(1);
    expect(firstAtOrAfter(hits, 10)).toBe(2);
    expect(firstAtOrAfter(hits, 11)).toBe(3);
    expect(firstAtOrAfter(hits, 21)).toBe(1);
    expect(firstAtOrAfter([], 3)).toBe(0);
  });

  it('replacementPlan lists text hits last first, skips equal ones and counts links', () => {
    const hits = [hit(1, 5, false, 'sync'), hit(2, 10, true, 'Sync'), hit(3, 20, false, 'link')];
    hits.push(hit(4, 30, false, 'Sync'));
    expect(replacementPlan(hits, 'link')).toEqual({
      ranges: [
        { from: 30, to: 31 },
        { from: 5, to: 6 },
      ],
      skippedLinks: 1,
    });
  });
});
