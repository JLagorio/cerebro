import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  findExternalRefs,
  parseTranscript,
  sourceFreshness,
  speakersOf,
  titleFromContent,
  titleFromFilename,
  toWorkingDoc,
  turnsToMarkdown,
  uncachedRefs,
} from './ingest';
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
        cachePath: 'sources/web/wiki.test-x-rollback.md',
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

  it('builds the same cache paths the Rust writer does', () => {
    // Pinned against source_slugs_match_the_frontends_cache_paths in
    // src-tauri/src/mcp.rs. If these drift, every fetched source looks
    // uncached forever and the agent refetches on every turn.
    const cacheOf = (id: string) => findExternalRefs(id, { issuePrefixes: ['PHX'] })[0].cachePath;
    expect(cacheOf('PHX-421')).toBe('sources/issues/phx-421.md');
    expect(cacheOf('https://wiki.test/x/Rollback')).toBe('sources/web/wiki.test-x-rollback.md');
    expect(cacheOf('https://a.test/p?q=1&r=2')).toBe('sources/web/a.test-p-q-1-r-2.md');
    expect(cacheOf('http://a.test/p/')).toBe('sources/web/a.test-p.md');
  });

  it('drops sentence punctuation that is not part of the url', () => {
    expect(findExternalRefs('See https://wiki.test/page.').map((r) => r.id)).toEqual([
      'https://wiki.test/page',
    ]);
  });

  it('reports each reference once however often it is mentioned', () => {
    expect(findExternalRefs('PHX-421 blocks PHX-421', PHX)).toHaveLength(1);
  });

  it('only proposes a fetch for references with nothing cached', () => {
    const text = 'PHX-421 and PHX-9';
    expect(uncachedRefs(text, ['sources/issues/phx-421.md'], PHX).map((r) => r.id)).toEqual([
      'PHX-9',
    ]);
    // The cache is what keeps a repeat mention from becoming a repeat API call.
    expect(
      uncachedRefs(text, ['sources/issues/phx-421.md', 'sources/issues/phx-9.md'], PHX),
    ).toEqual([]);
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
    // The boundary matches the refresh lane: due ON the date, not after it.
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
