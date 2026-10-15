// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createBoard } from './board';
import { readCanvas, writeCanvas, fileLinkTarget, fileRefsOf, searchTextOf } from './jsonCanvas';

const card = { id: 'a', type: 'text', text: 'Hello [[Page]]', x: 0, y: 0, width: 100, height: 50 };
const source = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ nodes: [card], edges: [], ...extra });
function boardOf(input: string) {
  const read = readCanvas(input);
  if (!read.ok) throw new Error(read.message);
  return read.board;
}

const shared = resolve(__dirname, '../../../shared/canvas');
const caseText = (input: string) =>
  input.endsWith('.canvas') ? readFileSync(resolve(shared, 'goldens', input), 'utf8') : input;
it('replays the shared canvas cases', () => {
  const cases = JSON.parse(readFileSync(resolve(shared, 'cases.json'), 'utf8')) as {
    name: string;
    input: string;
    ok: boolean;
    reason?: string;
    message?: string;
    counts?: number[];
    problems?: unknown[];
    texts?: string[];
    links?: unknown[];
    search?: string;
    canonical?: string;
  }[];
  for (const c of cases) {
    const input = caseText(c.input);
    const read = readCanvas(input);
    expect(read.ok, c.name).toBe(c.ok);
    if (!read.ok) {
      expect(read, c.name).toEqual({ ok: false, reason: c.reason, message: c.message });
      continue;
    }
    expect([read.board.nodes.size, read.board.edges.size, read.board.ink.size], c.name).toEqual(
      c.counts,
    );
    expect(read.problems, c.name).toEqual(c.problems);
    expect(fileRefsOf(read.board), c.name).toEqual(c.links);
    expect(searchTextOf(read.board), c.name).toBe(c.search);
    expect(writeCanvas(read.board), c.name).toBe(
      c.canonical === 'same' ? input : caseText(c.canonical!),
    );
  }
});

it('refuses byte and item limits before creating a board', () => {
  expect(readCanvas(' '.repeat(8 * 1024 * 1024 + 1))).toMatchObject({
    ok: false,
    reason: 'too_large',
  });
  expect(
    readCanvas(
      source({ nodes: Array.from({ length: 5001 }, (_, i) => ({ ...card, id: String(i) })) }),
    ),
  ).toMatchObject({ ok: false, reason: 'too_large' });
});

it('a new board writes no Cerebro extras', () => {
  expect(writeCanvas(createBoard())).toBe('{\n\t"nodes": [],\n\t"edges": []\n}');
  expect(writeCanvas(boardOf('{}'))).toBe('{}');
});
it('keeps unknown raw values and known key order through a move and clipboard-shaped facts', () => {
  const input =
    '{"top":{"big":9007199254740993,"surrogate":"\\ud800"},"nodes":[{"vendor":1.2300e+4,"id":"a","type":"text","text":"Hello","x":0,"y":0,"width":100,"height":50}],"cerebro":{"version":1,"vendor":{"x":-0},"cards":{"a":{"shape":"ellipse","vendor":1e999}}}}';
  const board = boardOf(input);
  const output = writeCanvas(board);
  expect(output).toContain('"top": {"big":9007199254740993,"surrogate":"\\ud800"}');
  expect(output).toContain('"vendor":1.2300e+4,"id":"a"');
  expect(output).toContain('"shape":"ellipse","vendor":1e999');
  expect(writeCanvas(boardOf(output))).toBe(output);
  const node = board.nodes.get('a')!;
  const changed = { ...board, nodes: new Map([['a', { ...node, x: 10 }]]) };
  expect(writeCanvas(changed)).toBe(output.replace('"x":0', '"x":10'));
});
it('retains dangling edges and undrawable colours, drops orphan extras and reports each', () => {
  const read = readCanvas(
    source({
      edges: [{ id: 'e', fromNode: 'a', toNode: 'gone', color: 'pink' }],
      cerebro: { version: 1, cards: { gone: { shape: 'ellipse' } } },
    }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.problems).toEqual([
    { kind: 'dangling-edge', key: 'e:e', ends: 'to' },
    { kind: 'undrawable-color', key: 'e:e', color: 'pink' },
    { kind: 'orphan-card-extras', count: 1 },
  ]);
  expect(writeCanvas(read.board)).toContain('"toNode":"gone"');
  expect(writeCanvas(read.board)).not.toContain('"gone":');
});
it.each([
  ['{', 'not_json'],
  ['[]', 'not_board'],
  ['{"nodes":{}}', 'not_board'],
  ['{"cerebro":{"version":2}}', 'version'],
  ['{"cerebro":{}}', 'version'],
  [source({ nodes: [card, card] }), 'invalid'],
  [source({ nodes: [{ ...card, x: 0.5 }] }), 'invalid'],
  [source({ nodes: [{ ...card, width: 0 }] }), 'invalid'],
  [source({ nodes: [{ ...card, text: undefined }] }), 'invalid'],
  [source({ nodes: [{ ...card, type: 'other' }] }), 'invalid'],
  [source({ nodes: [{ ...card, text: '\ud800' }] }), 'invalid'],
  [source().replace('"x":0', '"x":0e0'), 'invalid'],
  ['['.repeat(33) + '0' + ']'.repeat(33), 'not_json'],
] as const)('refuses %s as %s without constructing an empty board', (input, reason) => {
  expect(readCanvas(input)).toMatchObject({ ok: false, reason });
});
it('drops a leading BOM, accepts CRLF and empty files, and writes negative zero plainly', () => {
  expect(writeCanvas(boardOf('\uFEFF' + source()))).toBe(writeCanvas(boardOf(source())));
  expect(writeCanvas(boardOf(source().replace('"x":0', '"x":-0')))).toContain('"x":0');
  expect(readCanvas(' \r\n\t')).toMatchObject({ ok: true, problems: [] });
});
it('searches card text and group labels, and derives page links from file cards', () => {
  const board = boardOf(
    source({
      nodes: [
        card,
        {
          id: 'b',
          type: 'file',
          file: 'projects/Launch/project.md',
          subpath: '#Next',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        { id: 'g', type: 'group', label: 'Group title', x: 0, y: 0, width: 1, height: 1 },
      ],
    }),
  );
  expect(searchTextOf(board)).toBe('Hello [[Page]]\nGroup title');
  expect(fileRefsOf(board)).toEqual([{ file: 'projects/Launch/project.md', subpath: '#Next' }]);
  expect(fileLinkTarget('projects/Launch/project.md', '#Next')).toBe('Launch#Next');
  expect(fileLinkTarget('a/b/Page.md', 'Heading')).toBe('Page#Heading');
  expect(fileLinkTarget('attachments/a.pdf')).toBe('a.pdf');
});
it('round-trips known ink and group options', () => {
  const input = source({
    nodes: [
      {
        ...card,
        type: 'group',
        text: undefined,
        background: 'attachments/a.png',
        backgroundStyle: 'ratio',
      },
    ],
    cerebro: {
      version: 1,
      ink: [
        {
          id: 's',
          x: 0,
          y: 0,
          width: 2,
          height: 3,
          color: '1',
          size: 2,
          simulated: true,
          points: [0, 0, 500, 20, 30, 1000],
        },
      ],
    },
  });
  const output = writeCanvas(boardOf(input));
  expect(writeCanvas(boardOf(output))).toBe(output);
  expect(output).toContain('"backgroundStyle":"ratio"');
  expect(output).toContain('"points":[0,0,500,20,30,1000]');
});
