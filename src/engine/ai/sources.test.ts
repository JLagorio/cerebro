import { describe, expect, it } from 'vitest';
import { collectSources, httpUrl, mergeSources, sourceKey, type SourceInput } from './sources';
import type { SourceRef } from './types';

const search = (results: { title: string; url: string }[]): SourceInput => ({
  from: 'result',
  data: { type: 'web_search', query: 'q', results },
});
const fetched = (url: string, code?: number): SourceInput => ({
  from: 'result',
  data: code === undefined ? { type: 'web_fetch', url } : { type: 'web_fetch', url, code },
});
const text = (reply: string): SourceInput => ({ from: 'text', text: reply });

describe('collectSources', () => {
  it('lists what a turn met, in order: search results, fetches, vault reads, links in the reply', () => {
    expect(
      collectSources([
        search([
          { title: 'Tauri 2 security', url: 'https://v2.tauri.app/security/' },
          { title: 'CSP', url: 'https://developer.mozilla.org/docs/Web/HTTP/CSP' },
        ]),
        fetched('https://v2.tauri.app/security/capabilities/'),
        { from: 'read', path: 'notes/tauri.md', title: 'Tauri notes' },
        text('Capabilities gate each window ([guide](https://v2.tauri.app/start/)).'),
      ]),
    ).toEqual([
      {
        kind: 'url',
        url: 'https://v2.tauri.app/security/',
        title: 'Tauri 2 security',
        via: 'search',
      },
      {
        kind: 'url',
        url: 'https://developer.mozilla.org/docs/Web/HTTP/CSP',
        title: 'CSP',
        via: 'search',
      },
      { kind: 'url', url: 'https://v2.tauri.app/security/capabilities/', via: 'fetch' },
      { kind: 'vault', path: 'notes/tauri.md', title: 'Tauri notes', via: 'read' },
      { kind: 'url', url: 'https://v2.tauri.app/start/', title: 'guide', via: 'text' },
    ]);
  });

  it('lists a source met twice once, where first met, with the first title it was given', () => {
    const sources = collectSources([
      fetched('https://Example.com/a#intro'),
      search([{ title: 'Example A', url: 'https://example.com/a' }]),
      search([{ title: 'Another title', url: 'https://example.com/a' }]),
      { from: 'read', path: './notes/a.md' },
      { from: 'read', path: 'notes/a.md', title: 'A' },
      text('See https://example.com/ and https://EXAMPLE.com'),
    ]);
    expect(sources).toEqual([
      { kind: 'url', url: 'https://Example.com/a#intro', title: 'Example A', via: 'fetch' },
      { kind: 'vault', path: 'notes/a.md', title: 'A', via: 'read' },
      { kind: 'url', url: 'https://example.com/', via: 'text' },
    ]);
  });

  it('never lists a fetch that ended on an HTTP error', () => {
    expect(collectSources([fetched('https://example.com/gone', 404)])).toEqual([]);
    expect(collectSources([fetched('https://example.com/moved', 200)])).toHaveLength(1);
  });

  it('keeps only http(s) URLs as url sources', () => {
    const sources = collectSources([
      search([
        { title: 'file', url: 'file:///etc/passwd' },
        { title: 'script', url: 'javascript:alert(1)' },
        { title: 'creds', url: 'https://user:secret@example.com/' },
        { title: 'no host', url: 'https://' },
        { title: 'ok', url: '  http://example.org/ok  ' },
      ]),
      text('[local](notes/a.md) and [[Wiki page]] and mailto:me@example.com'),
    ]);
    expect(sources).toEqual([
      { kind: 'url', url: 'http://example.org/ok', title: 'ok', via: 'search' },
    ]);
  });

  it('keeps only vault-relative page paths as vault sources', () => {
    const reads = [
      '/Users/me/vault/a.md',
      '../outside.md',
      'notes/../a.md',
      'https://x.com/a',
      'C:\\a.md',
      '',
    ];
    expect(collectSources(reads.map((path) => ({ from: 'read', path })))).toEqual([]);
  });

  it('ignores calls with no source in them', () => {
    expect(
      collectSources([
        {
          from: 'result',
          data: {
            type: 'shell',
            stdout: 'https://example.com',
            stderr: '',
            interrupted: false,
            truncated: false,
          },
        },
        { from: 'result', data: { type: 'todos', todos: [] } },
        { from: 'result', data: { type: 'agent', summary: 'Read https://example.com/x' } },
      ]),
    ).toEqual([]);
  });
});

describe('links in the reply', () => {
  const urls = (reply: string) => collectSources([text(reply)]).map((s) => [s.url, s.title]);

  it('reads markdown links, autolinks and bare URLs in the order written', () => {
    expect(
      urls(
        'First [the spec](https://spec.example/a "Spec"), then <https://b.example/x>, then https://c.example/y.',
      ),
    ).toEqual([
      ['https://spec.example/a', 'the spec'],
      ['https://b.example/x', undefined],
      ['https://c.example/y', undefined],
    ]);
  });

  it('keeps parentheses a URL opened and drops the sentence around it', () => {
    expect(
      urls(
        '(see https://en.wikipedia.org/wiki/Foo_(bar)), and [Baz](https://en.wikipedia.org/wiki/Baz_(qux)); also https://x.example/a?b=1!',
      ),
    ).toEqual([
      ['https://en.wikipedia.org/wiki/Foo_(bar)', undefined],
      ['https://en.wikipedia.org/wiki/Baz_(qux)', 'Baz'],
      ['https://x.example/a?b=1', undefined],
    ]);
  });

  it('reads no link inside code, and no image as a source', () => {
    expect(
      urls(
        [
          'Run `curl https://api.example/v1` first.',
          '```sh',
          'curl https://api.example/v2',
          '```',
          '![chart](https://img.example/chart.png)',
          'Docs: https://docs.example/',
        ].join('\n'),
      ),
    ).toEqual([['https://docs.example/', undefined]]);
  });

  it('gives a link labelled with its own URL no title', () => {
    expect(urls('[https://a.example/](https://a.example/)')).toEqual([
      ['https://a.example/', undefined],
    ]);
  });
});

describe('sourceKey', () => {
  it('reads a URL case-blind in scheme and host, without its fragment, an empty path as "/"', () => {
    const key = (url: string) => sourceKey({ kind: 'url', url, via: 'text' });
    expect(key('HTTPS://Example.COM/A?b=1#intro')).toBe('url:https://example.com/A?b=1');
    expect(key('https://example.com')).toBe(key('https://example.com/'));
    expect(key('https://example.com/a')).not.toBe(key('https://example.com/a/'));
  });

  it('reads a vault page by its path, never as a URL', () => {
    expect(sourceKey({ kind: 'vault', path: 'notes/a.md', via: 'read' })).toBe('path:notes/a.md');
    expect(sourceKey({ kind: 'vault', path: 'example.com/a', via: 'read' })).not.toBe(
      sourceKey({ kind: 'url', url: 'https://example.com/a', via: 'text' }),
    );
  });
});

describe('mergeSources', () => {
  const url = (address: string, title?: string): SourceRef =>
    title === undefined
      ? { kind: 'url', url: address, via: 'search' }
      : { kind: 'url', url: address, title, via: 'search' };
  const page = (path: string, title?: string): SourceRef =>
    title === undefined
      ? { kind: 'vault', path, via: 'read' }
      : { kind: 'vault', path, title, via: 'read' };
  const rows = (cited: ReturnType<typeof mergeSources>) =>
    cited.map(({ source, turn }) => [source.kind === 'url' ? source.url : source.path, turn]);

  it('lists the latest reply’s sources first, in that reply’s own order, then the replies before it', () => {
    const merged = mergeSources([
      { turn: 't1', sources: [url('https://a.example/'), page('notes/b.md')] },
      { turn: 't2', sources: [] },
      { turn: 't3', sources: [url('https://c.example/'), url('https://d.example/')] },
    ]);
    expect(rows(merged)).toEqual([
      ['https://c.example/', 't3'],
      ['https://d.example/', 't3'],
      ['https://a.example/', 't1'],
      ['notes/b.md', 't1'],
    ]);
  });

  it('lists a source more than one reply drew on once, under the latest', () => {
    const merged = mergeSources([
      { turn: 't1', sources: [url('https://example.com/a#intro'), page('notes/b.md')] },
      { turn: 't2', sources: [page('notes/c.md'), url('https://EXAMPLE.com/a')] },
      { turn: 't3', sources: [page('notes/b.md')] },
    ]);
    expect(rows(merged)).toEqual([
      ['notes/b.md', 't3'],
      ['notes/c.md', 't2'],
      ['https://EXAMPLE.com/a', 't2'],
    ]);
  });

  it('keeps the title the latest reply gave, else the latest an earlier one gave', () => {
    const titles = (...given: (string | undefined)[]) =>
      mergeSources(
        given.map((title, i) => ({
          turn: `t${i + 1}`,
          sources: [url('https://a.example/', title)],
        })),
      ).map(({ source }) => source.title);
    expect(titles('Old', 'New')).toEqual(['New']);
    expect(titles('First', 'Second', undefined)).toEqual(['Second']);
    expect(titles(undefined, undefined)).toEqual([undefined]);
  });

  it('never writes to the replies’ lists', () => {
    const untitled = Object.freeze(url('https://a.example/'));
    const first = Object.freeze([untitled]);
    const second = Object.freeze([Object.freeze(url('https://a.example/', 'A'))]);
    const merged = mergeSources([
      { turn: 't1', sources: second },
      { turn: 't2', sources: first },
    ]);
    expect(merged[0].source).toEqual({ ...untitled, title: 'A' });
    expect(untitled).not.toHaveProperty('title');
  });

  it('dedupes across replies by the key a reply’s own list dedupes by', () => {
    const met: SourceInput[] = [
      fetched('https://Example.com/a#intro'),
      search([{ title: 'A', url: 'https://example.com/a' }]),
      text('See HTTPS://EXAMPLE.COM/a and https://example.com and https://example.com/.'),
      { from: 'read', path: './notes/a.md' },
      { from: 'read', path: 'notes/a.md', title: 'Notes A' },
      fetched('https://example.com/a/'),
    ];
    const oneReply = collectSources(met);
    const replyEach = mergeSources(
      met.map((input, i) => ({ turn: `t${i + 1}`, sources: collectSources([input]) })),
    );
    expect(replyEach.map(({ source }) => sourceKey(source)).sort()).toEqual(
      oneReply.map(sourceKey).sort(),
    );
    expect(oneReply).toHaveLength(4);
  });

  it('is empty for no replies', () => {
    expect(mergeSources([])).toEqual([]);
  });
});

describe('httpUrl', () => {
  it.each([
    ['https://example.com/a?b#c', 'https://example.com/a?b#c'],
    [' http://localhost:5173/ ', 'http://localhost:5173/'],
    ['https://[::1]:8080/', 'https://[::1]:8080/'],
    ['ftp://example.com/', null],
    ['//example.com', null],
    ['https://exa mple.com', null],
    ['https://user@example.com', null],
    ['https://example.com/a\nb', null],
    ['https://exam\tple.com/', null],
    ['notes/a.md', null],
  ])('%s', (raw, expected) => {
    expect(httpUrl(raw)).toBe(expected);
  });
});
