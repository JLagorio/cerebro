import { describe, expect, it } from 'vitest';
import SOURCE_SLUGS from '../../src-tauri/fixtures/source-slugs.json';
import {
  canonicalSourceId,
  detectFormat,
  filedCopyOf,
  findExternalRefs,
  parseTranscript,
  sourceCachePath,
  sourceFreshness,
  type SourceKind,
  speakersOf,
  titleFromContent,
  titleFromFilename,
  toWorkingDoc,
  turnsToMarkdown,
  uncachedRefs,
} from './ingest';
import { sha256Hex } from '@/lib/sha256';
import { makeEntry } from './testHelpers';

const AT = '2026-07-28T14:00:00Z';

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Tom Keller>We have a cutover plan but nobody has

2
00:00:04.000 --> 00:00:07.500
practised the rollback end to end.

3
00:00:08.000 --> 00:00:12.000
Priya Nair: And the go-live date locks Friday, so PHX-421 has to land.
`;

const SRT = `1
00:00:01,000 --> 00:00:04,000
Tom Keller: The pick queue does not drain instantly.

2
00:00:05,000 --> 00:00:09,000
Priya Nair: Right.
`;

describe('detectFormat', () => {
  it('trusts the extension first', () => {
    expect(detectFormat('a.vtt', 'anything')).toBe('vtt');
    expect(detectFormat('a.srt', 'anything')).toBe('srt');
    expect(detectFormat('a.md', 'x')).toBe('markdown');
    expect(detectFormat('a.markdown', 'x')).toBe('markdown');
  });

  it('sniffs a transcript exported with the wrong extension', () => {
    // The extension is the least reliable thing about a file that has been
    // through three tools.
    expect(detectFormat('meeting.txt', VTT)).toBe('vtt');
    expect(detectFormat('meeting.txt', SRT)).toBe('srt');
  });

  it('tolerates a BOM in front of the header', () => {
    expect(detectFormat('x.txt', `\uFEFF${VTT}`)).toBe('vtt');
  });

  it('falls back to plain text', () => {
    expect(detectFormat('notes.txt', 'just some prose')).toBe('text');
    expect(detectFormat('', 'pasted words')).toBe('text');
  });
});

describe('parseTranscript', () => {
  it('reads voice spans and merges the cues that continue a turn', () => {
    const turns = parseTranscript(VTT);
    expect(turns).toHaveLength(2);
    // Merging matters: a distiller reading 3-second fragments loses the shape
    // of an argument that took a minute to make.
    expect(turns[0]).toEqual({
      speaker: 'Tom Keller',
      at: '00:00:01',
      text: 'We have a cutover plan but nobody has practised the rollback end to end.',
    });
    expect(turns[1].speaker).toBe('Priya Nair');
    expect(turns[1].at).toBe('00:00:08');
  });

  it('reads the bare `Speaker:` prefix that most meeting tools emit', () => {
    const turns = parseTranscript(SRT);
    expect(turns.map((t) => t.speaker)).toEqual(['Tom Keller', 'Priya Nair']);
    expect(turns[0].text).toBe('The pick queue does not drain instantly.');
  });

  it('does not read a colon inside prose as a speaker', () => {
    // Length cannot separate "The rule is simple" from "Tom van der Berg";
    // title-case can, and it fails on the sentence's second word.
    const turns = parseTranscript(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nThe rule is simple: we ship on Friday.\n',
    );
    expect(turns[0].speaker).toBeNull();
    expect(turns[0].text).toBe('The rule is simple: we ship on Friday.');
  });

  it('still reads a name carrying lowercase particles', () => {
    const turns = parseTranscript(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nTom van der Berg: Ship it.\n',
    );
    expect(turns[0].speaker).toBe('Tom van der Berg');
    expect(turns[0].text).toBe('Ship it.');
  });

  it('trusts an explicit voice span even when the name is unusual', () => {
    // `<v ...>` is a declaration, not a guess, so it is never second-guessed.
    const turns = parseTranscript(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v the whole room>Agreed.\n',
    );
    expect(turns[0].speaker).toBe('the whole room');
  });

  it('drops styling and karaoke tags but keeps the words', () => {
    const turns = parseTranscript(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<c.colorE5E5E5>Ship</c> <00:00:02.000><i>it</i>\n',
    );
    expect(turns[0].text).toBe('Ship it');
  });

  it('skips NOTE, STYLE, and bare cue indices', () => {
    const turns = parseTranscript(
      'WEBVTT\n\nNOTE recorded by Zoom\n\nSTYLE\n::cue { color: red }\n\n7\n00:00:01.000 --> 00:00:02.000\nHello\n',
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('Hello');
  });

  it('normalizes short and comma-decimal timestamps', () => {
    const turns = parseTranscript('WEBVTT\n\n01:04.500 --> 01:08.000\nLate in the call\n');
    expect(turns[0].at).toBe('00:01:04');
  });

  it('returns nothing for a file with no cues', () => {
    expect(parseTranscript('WEBVTT\n\n')).toEqual([]);
  });
});

describe('turnsToMarkdown', () => {
  it('keeps the timestamp so a distilled claim stays checkable', () => {
    expect(turnsToMarkdown(parseTranscript(SRT))).toBe(
      '`00:00:01` **Tom Keller:** The pick queue does not drain instantly.\n\n' +
        '`00:00:05` **Priya Nair:** Right.',
    );
  });

  it('omits the speaker label when nobody is attributed', () => {
    expect(turnsToMarkdown([{ speaker: null, at: null, text: 'Just words' }])).toBe('Just words');
  });
});

describe('speakersOf', () => {
  it('lists each speaker once, in first-appearance order', () => {
    expect(speakersOf(parseTranscript(VTT))).toEqual(['Tom Keller', 'Priya Nair']);
  });
});

describe('titles', () => {
  it('strips dates, counters, separators, and export noise from a filename', () => {
    expect(titleFromFilename('2026-07-28 Phoenix Standup (1).vtt')).toBe('Phoenix Standup');
    expect(titleFromFilename('transcript-warehouse-sync.vtt')).toBe('warehouse sync');
    expect(titleFromFilename('weekly_1on1_2026-07-28.txt')).toBe('weekly 1on1');
  });

  it('prefers an H1, then the first real line', () => {
    expect(titleFromContent('---\nx: 1\n---\n\n# Real title\n\nbody')).toBe('Real title');
    expect(titleFromContent('Tom Keller: We need a rehearsal')).toBe('We need a rehearsal');
  });

  it('truncates a long opening line rather than titling a note with a paragraph', () => {
    const title = titleFromContent('x'.repeat(200));
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('toWorkingDoc', () => {
  it('never assigns a type — untyped is what queues it in the Inbox', () => {
    const doc = toWorkingDoc({ filename: 'sync.vtt', content: VTT, at: AT });
    expect(doc.frontmatter.type).toBeUndefined();
  });

  it('records the provenance a distilled concept will cite', () => {
    const doc = toWorkingDoc({ filename: 'sync.vtt', content: VTT, at: AT });
    expect(doc.frontmatter).toMatchObject({
      source_file: 'sync.vtt',
      ingested_at: AT,
      ingest_format: 'vtt',
      speakers: ['Tom Keller', 'Priya Nair'],
      duration: '00:00:08',
    });
  });

  it('converts a transcript to speaker-merged prose under an H1', () => {
    const doc = toWorkingDoc({ filename: 'sync.vtt', content: VTT, at: AT });
    expect(doc.title).toBe('sync');
    expect(doc.body.startsWith('# sync\n\n`00:00:01` **Tom Keller:**')).toBe(true);
    expect(doc.body).not.toContain('-->');
    expect(doc.body).not.toContain('WEBVTT');
  });

  it('keeps pasted text verbatim and still records where it came from', () => {
    const doc = toWorkingDoc({ filename: '', content: '# Notes\n\nSome thoughts.', at: AT });
    expect(doc.title).toBe('Notes');
    expect(doc.body).toContain('Some thoughts.');
    expect(doc.frontmatter.source_file).toBeUndefined();
    // "Pasted on this date" is still an answer to where it came from.
    expect(doc.frontmatter.ingested_at).toBe(AT);
  });

  it('falls back to a title rather than writing an untitled note', () => {
    expect(toWorkingDoc({ filename: '', content: '   ', at: AT }).title).toBe('Untitled capture');
  });

  it('omits transcript-only fields for prose', () => {
    const doc = toWorkingDoc({ filename: 'notes.txt', content: 'plain', at: AT });
    expect(doc.frontmatter.speakers).toBeUndefined();
    expect(doc.frontmatter.duration).toBeUndefined();
  });

  // M64.7 — absent reads "not recorded", so a transcript that names nobody
  // says so with an empty list.
  it('records speakers: [] for a transcript that names nobody', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nthe rollback is not rehearsed\n';
    const doc = toWorkingDoc({ filename: 'call.vtt', content: vtt, at: AT });
    expect(doc.frontmatter.speakers).toEqual([]);
  });
});

describe('source_sha256 and repeats (M64.7)', () => {
  it.each([
    ['vtt', 'sync.vtt', VTT],
    ['srt', 'sync.srt', SRT],
    ['markdown', 'notes.md', '# Notes\n\nSome thoughts.'],
    ['text', 'notes.txt', 'plain words'],
    ['paste', '', 'A pasted wall of text.'],
  ])('stamps the hash of the text on a %s inlet', (_kind, filename, content) => {
    const doc = toWorkingDoc({ filename, content, at: AT });
    expect(doc.frontmatter.source_sha256).toBe(sha256Hex(content));
    expect(doc.frontmatter.source_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives equal content an equal hash, whatever the name or the moment', () => {
    const a = toWorkingDoc({ filename: 'a.vtt', content: VTT, at: AT });
    const b = toWorkingDoc({ filename: 'renamed.vtt', content: VTT, at: '2026-08-01T00:00:00Z' });
    expect(a.frontmatter.source_sha256).toBe(b.frontmatter.source_sha256);
    const c = toWorkingDoc({ filename: 'a.vtt', content: `${VTT} `, at: AT });
    expect(c.frontmatter.source_sha256).not.toBe(a.frontmatter.source_sha256);
  });

  const SHA = sha256Hex(VTT);
  const at = (path: string, sha: string | null = SHA) =>
    makeEntry({ path, properties: sha === null ? {} : { source_sha256: sha } });

  it('filedCopyOf finds a copy in any folder', () => {
    const copy = at('records/meetings/sync.md');
    expect(filedCopyOf([at('inbox/other.md', null), copy], SHA)).toBe(copy);
  });

  it('filedCopyOf skips the knowledge bundle', () => {
    expect(filedCopyOf([at('knowledge/systems/sync.md')], SHA)).toBeNull();
  });

  it('filedCopyOf picks the first in path order', () => {
    const first = at('archive/sync.md');
    expect(filedCopyOf([at('inbox/sync.md'), first, at('records/sync.md')], SHA)).toBe(first);
  });

  it('filedCopyOf returns null when nothing holds the material', () => {
    expect(
      filedCopyOf([at('inbox/a.md', sha256Hex('other')), at('inbox/b.md', null)], SHA),
    ).toBeNull();
  });
});

describe('external references', () => {
  const PHX = { issuePrefixes: ['PHX'] };

  it('finds declared issue keys and urls, and says where each would be cached', () => {
    const refs = findExternalRefs(
      'Blocked on PHX-421, see https://wiki.test/x/Rollback plan.',
      PHX,
    );
    expect(refs).toEqual([
      { kind: 'issue', id: 'PHX-421', cachePath: 'sources/issues/phx-421.md' },
      {
        kind: 'url',
        id: 'https://wiki.test/x/Rollback',
        cachePath: 'sources/web/wiki.test-x-rollback-16990b2f5ec5.md',
      },
    ]);
  });

  it('detects no issue at all until the project keys are declared', () => {
    // `PHX-421` and `UTF-8` are the same shape, so shape cannot separate
    // them. A miss is the right failure here: a false positive costs a
    // connector round trip and a cache file for a ticket that never existed.
    expect(findExternalRefs('Blocked on PHX-421')).toHaveLength(0);
    expect(findExternalRefs('COVID-19 and UTF-8 and ISO-8601', PHX)).toHaveLength(0);
  });

  it('matches declared keys case-insensitively and ignores malformed ones', () => {
    expect(findExternalRefs('PHX-421', { issuePrefixes: ['phx'] })).toHaveLength(1);
    expect(findExternalRefs('PHX-421', { issuePrefixes: ['', '  ', '1BAD-'] })).toHaveLength(0);
  });

  it('does not match a declared key embedded in a longer token', () => {
    expect(findExternalRefs('SUPERPHX-421 and PHX-421X', PHX)).toHaveLength(0);
  });

  it('replays the cache paths it shares with the Rust writer', () => {
    // src-tauri/fixtures/source-slugs.json, which
    // source_slugs_replay_the_shared_cases in src-tauri/src/mcp.rs replays
    // too. The Inbox counts a copy by the identity and path cache_source
    // gave it, so twins that drift can make a fetched source look uncached,
    // and it is fetched again.
    const sources = new Map<string, string>();
    for (const { kind, id, canonical, path } of SOURCE_SLUGS.cases) {
      expect(['issue', 'web']).toContain(kind);
      const source = kind as SourceKind;
      expect(canonicalSourceId(source, id), JSON.stringify(id)).toBe(canonical);
      expect(sourceCachePath(source, id), JSON.stringify(id)).toBe(path);
      // Two sources sharing one file is how the second fetch overwrote the first.
      const identity = `${source}\0${canonical}`;
      expect(sources.get(path) ?? identity, path).toBe(identity);
      sources.set(path, identity);
    }
  });

  it('drops sentence punctuation that is not part of the url', () => {
    expect(findExternalRefs('See https://wiki.test/page.').map((r) => r.id)).toEqual([
      'https://wiki.test/page',
    ]);
  });

  it('reports each reference once however often it is mentioned', () => {
    expect(findExternalRefs('PHX-421 blocks PHX-421', PHX)).toHaveLength(1);
  });

  it('one reference per source however it is spelled', () => {
    const refs = findExternalRefs(
      'See https://wiki.test/x/Rollback, http://Wiki.Test/x/Rollback/ and https://wiki.test/x/rollback.',
    );
    // The first spelling is what a fetch asks for. Path case is identity, so
    // the last is another page.
    expect(refs.map((r) => r.id)).toEqual([
      'https://wiki.test/x/Rollback',
      'https://wiki.test/x/rollback',
    ]);
  });

  it('offers nothing for a url with nothing left to fetch', () => {
    // cache_source refuses an id that canonicalizes to nothing, so a fetch
    // offered for one could never be written down.
    expect(findExternalRefs('See https://... or https:///')).toEqual([]);
  });

  it('only proposes a fetch for references with nothing cached', () => {
    const text = 'PHX-421 and PHX-9';
    const at = (...paths: string[]) => paths.map((path) => makeEntry({ path }));
    expect(uncachedRefs(text, at('sources/issues/phx-421.md'), PHX).map((r) => r.id)).toEqual([
      'PHX-9',
    ]);
    // The cache is what keeps a repeat mention from becoming a repeat API call.
    expect(
      uncachedRefs(text, at('sources/issues/phx-421.md', 'sources/issues/phx-9.md'), PHX),
    ).toEqual([]);
  });

  it('finds a copy by its source_id even at a legacy path', () => {
    // Where the old rule filed it. cache_source refreshes a copy where it
    // lives, so the Inbox has to count this one rather than offer a fetch.
    const legacy = makeEntry({
      path: 'sources/web/wiki.test-x-rollback.md',
      properties: { source_id: 'https://wiki.test/x/Rollback', source_kind: 'web' },
    });
    expect(uncachedRefs('See https://wiki.test/x/Rollback.', [legacy])).toEqual([]);
    expect(uncachedRefs('See http://WIKI.test/x/Rollback/ again.', [legacy])).toEqual([]);
    // A kind nobody recorded is no disagreement.
    for (const properties of [
      { source_id: ' PHX-421' },
      { source_id: 'phx-421', source_kind: null },
    ]) {
      const copy = makeEntry({ path: 'sources/jira/phx.md', properties });
      expect(uncachedRefs('PHX-421', [copy], PHX)).toEqual([]);
    }
    // Path case is identity: another page has no copy yet.
    expect(uncachedRefs('See https://wiki.test/x/rollback.', [legacy]).map((r) => r.id)).toEqual([
      'https://wiki.test/x/rollback',
    ]);
  });

  it('a copy outside sources/ or of another kind does not count', () => {
    const url = 'https://wiki.test/x/Rollback';
    const entries = [
      // A note that names the page is not a copy of it.
      makeEntry({ path: 'records/x.md', properties: { source_id: url, source_kind: 'web' } }),
      // Nor is a copy that says it is of an issue.
      makeEntry({
        path: 'sources/issues/odd.md',
        properties: { source_id: url, source_kind: 'issue' },
      }),
    ];
    expect(uncachedRefs(`See ${url}.`, entries).map((r) => r.id)).toEqual([url]);
  });
});

describe('sourceFreshness (M34.5.2)', () => {
  const TODAY = '2026-08-21';
  const cached = (properties: Record<string, unknown>) =>
    makeEntry({ path: 'sources/issues/phx-421.md', title: 'PHX-421', properties });

  it('a record without fetch bookkeeping is not a cached copy — null, not a state', () => {
    expect(sourceFreshness(cached({}), TODAY)).toBeNull();
    // Gated on PROPERTIES, never on a type name: a Source-typed record with
    // no bookkeeping still says nothing, and a record elsewhere with it does.
    expect(sourceFreshness(makeEntry({ path: 'records/x.md', title: 'X' }), TODAY)).toBeNull();
  });

  it('past its refresh date is stale, and says since when', () => {
    expect(
      sourceFreshness(
        cached({ stale_after: '2026-08-01', fetched_at: '2026-07-20T10:00:00Z' }),
        TODAY,
      ),
    ).toEqual({ state: 'stale', staleAfter: '2026-08-01', fetchedAt: '2026-07-20T10:00:00Z' });
    // Due ON the date, not after it.
    expect(sourceFreshness(cached({ stale_after: TODAY }), TODAY)?.state).toBe('stale');
  });

  it('a future refresh date is fresh until then', () => {
    expect(
      sourceFreshness(
        cached({ stale_after: '2026-09-01', fetched_at: '2026-08-20T10:00:00Z' }),
        TODAY,
      ),
    ).toEqual({ state: 'fresh', staleAfter: '2026-09-01', fetchedAt: '2026-08-20T10:00:00Z' });
  });

  it('no stale_after is NO EXPIRY — never silently fresh, never a default schedule', () => {
    expect(sourceFreshness(cached({ fetched_at: '2026-08-20T10:00:00Z' }), TODAY)).toEqual({
      state: 'no-expiry',
      fetchedAt: '2026-08-20T10:00:00Z',
    });
  });

  it('an unrecorded fetch is null, never zero', () => {
    expect(sourceFreshness(cached({ stale_after: '2026-08-01' }), TODAY)?.fetchedAt).toBeNull();
    // Malformed bookkeeping reads as absent, not as a state.
    expect(sourceFreshness(cached({ stale_after: 7, fetched_at: '' }), TODAY)).toBeNull();
  });
});
