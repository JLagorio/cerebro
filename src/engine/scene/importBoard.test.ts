import { describe, expect, it } from 'vitest';
import { orderedNodes } from './board';
import { importBoard, importReportLines, type ImportSketch, type SketchEdge } from './importBoard';
import { readCanvas, writeCanvas } from './jsonCanvas';

const sketch = (patch: Partial<ImportSketch> = {}): ImportSketch => ({
  nodes: [],
  groups: [],
  edges: [],
  icons: 0,
  animations: 0,
  alphaColors: 0,
  styleKeys: [],
  leftovers: [],
  settings: false,
  ...patch,
});
const edge = (from: string, to: string, patch: Partial<SketchEdge> = {}): SketchEdge => ({
  from,
  to,
  fromEnd: 'none',
  toEnd: 'arrow',
  invisible: false,
  specialHeads: 0,
  stroke: 'normal',
  ...patch,
});
const options = { pageCard: { width: 320, height: 120 } };

describe('manual board conversion', () => {
  it('keeps measured sizes and saved centres, fixes page size, and places unpositioned cards below', () => {
    const input = sketch({
      nodes: [
        { id: 'a', label: 'A', shape: 'rect', position: { x: 100, y: 80 } },
        { id: 'b', label: 'B', shape: 'rect', file: 'work/b.md', position: { x: 500, y: 80 } },
        { id: 'c', label: 'C', shape: 'rounded', position: { x: 100, y: 300 } },
        { id: 'd', label: 'D', shape: 'rect' },
        { id: 'e', label: 'E', shape: 'rect' },
      ],
    });
    const { board, report } = importBoard(input, {
      ...options,
      measured: new Map([
        ['a', { x: 0, y: 0, width: 101, height: 51 }],
        ['b', { x: 0, y: 0, width: 10, height: 10 }],
      ]),
    });
    expect(board.nodes.get('a')).toMatchObject({ x: 50, y: 55, width: 101, height: 51 });
    expect(board.nodes.get('b')).toMatchObject({
      type: 'file',
      file: 'work/b.md',
      x: 340,
      y: 20,
      width: 320,
      height: 120,
    });
    expect(board.nodes.get('c')).toMatchObject({ x: 20, y: 260, width: 160, height: 80 });
    expect(board.nodes.get('d')).toMatchObject({ x: 0, y: 404 });
    expect(board.nodes.get('e')).toMatchObject({ x: 192, y: 404 });
    expect(report).toMatchObject({ pageCards: 1, defaultSizes: 3, unpositioned: 2 });
  });
  it('uses a measured centre when there is no saved centre', () => {
    const { board, report } = importBoard(
      sketch({ nodes: [{ id: 'a', label: 'A', shape: 'rect' }] }),
      {
        ...options,
        measured: new Map([['a', { x: 12, y: 34, width: 80, height: 40 }]]),
      },
    );
    expect(board.nodes.get('a')).toMatchObject({ x: 12, y: 34, width: 80, height: 40 });
    expect(report.unpositioned).toBe(0);
  });
  it('maps shapes, keeps URL text and normalized hex, and reports unsupported names safely', () => {
    const names = [
      'rect',
      'rounded',
      'stadium',
      'subroutine',
      'circle',
      'diamond',
      'hexagon',
      '__proto__',
    ];
    const { board, report } = importBoard(
      sketch({
        nodes: names.map((shape, id) => ({
          id: String(id),
          label: `N${id}`,
          shape,
          color: '#ABC',
          ...(id === 0 ? { target: 'https://example.com' } : {}),
        })),
      }),
      options,
    );
    expect([...board.nodes.values()].map((n) => (n.type === 'text' ? n.shape : null))).toEqual([
      'rectangle',
      'rectangle',
      'rectangle',
      'rectangle',
      'ellipse',
      'diamond',
      'rectangle',
      'rectangle',
    ]);
    expect(board.nodes.get('0')).toMatchObject({
      text: '[N0](https://example.com)',
      color: '#aabbcc',
    });
    expect(report.plainShapes).toEqual({ hexagon: 1, ['__proto__']: 1 });
    expect(report.extraShapes).toEqual({ ellipse: 1, diamond: 1 });
    expect(writeCanvas(board)).not.toContain('var(');
  });
  it('wraps nested groups outward, puts groups first, and disambiguates ids and parallel edges', () => {
    const { board, report } = importBoard(
      sketch({
        nodes: [
          { id: 'group-outer', label: 'A', shape: 'rect', position: { x: 100, y: 100 } },
          { id: 'b', label: 'B', shape: 'rect', position: { x: 400, y: 100 } },
        ],
        groups: [
          { id: 'inner', label: 'Inside', members: ['group-outer'], parent: 'outer' },
          { id: 'outer', label: 'Outside', members: [] },
          { id: 'empty', label: 'Empty', members: [] },
        ],
        edges: [
          edge('outer', 'b', { label: 'go' }),
          edge('outer', 'b'),
          edge('empty', 'b'),
          edge('gone', 'b'),
          edge('b', 'gone', { invisible: true, stroke: 'invisible' }),
        ],
      }),
      options,
    );
    expect(orderedNodes(board).map((n) => n.id)).toEqual([
      'group-outer-2',
      'group-inner',
      'group-outer',
      'b',
    ]);
    expect(board.nodes.get('group-inner')).toMatchObject({ x: -4, y: 36, width: 208, height: 128 });
    expect(board.nodes.get('group-outer-2')).toMatchObject({
      x: -28,
      y: 12,
      width: 256,
      height: 176,
    });
    expect([...board.edges.keys()]).toEqual(['e-outer-b', 'e-outer-b-2']);
    expect(board.edges.get('e-outer-b')).toMatchObject({
      fromNode: 'group-outer-2',
      toNode: 'b',
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'none',
      toEnd: 'arrow',
      label: 'go',
    });
    expect(report).toMatchObject({ groups: 2, emptyGroups: 1, missingEndpoints: 2, invisible: 1 });
    const bytes = writeCanvas(board);
    expect(readCanvas(bytes).ok).toBe(true);
  });
  it('counts changed connections and produces byte-identical output', () => {
    const input = sketch({
      nodes: [
        { id: 'a', label: 'A', shape: 'rect' },
        { id: 'b', label: 'B', shape: 'rect' },
      ],
      edges: [
        edge('a', 'b', { fromEnd: 'arrow', specialHeads: 2, stroke: 'thick' }),
        edge('b', 'a', { toEnd: 'none', stroke: 'dotted' }),
      ],
    });
    const first = importBoard(input, options),
      second = importBoard(input, options);
    expect(first.report).toMatchObject({ specialHeads: 2, thick: 1, dotted: 1 });
    expect(first.board.edges.get('e-a-b')).toMatchObject({ fromEnd: 'arrow', toEnd: 'arrow' });
    expect(writeCanvas(first.board)).toBe(writeCanvas(second.board));
  });
  it('refuses invalid bounds and group cycles before producing content', () => {
    expect(() =>
      importBoard(
        sketch({
          nodes: [{ id: 'a', label: 'A', shape: 'rect', position: { x: Infinity, y: 0 } }],
        }),
        options,
      ),
    ).toThrow();
    expect(() =>
      importBoard(
        sketch({
          nodes: [],
          groups: [
            { id: 'a', label: '', members: [], parent: 'b' },
            { id: 'b', label: '', members: [], parent: 'a' },
          ],
        }),
        options,
      ),
    ).toThrow('group cycle');
  });
  it.each([1, 2])('reports singular and plural losses (%s)', (n) => {
    const { report } = importBoard(sketch(), options);
    const lines = importReportLines({
      ...report,
      nodes: n,
      links: n,
      groups: n,
      pageCards: n,
      defaultSizes: n,
      unpositioned: n,
      plainShapes: { hexagon: n },
      extraShapes: { diamond: n },
      specialHeads: n,
      invisible: n,
      missingEndpoints: n,
      emptyGroups: n,
      thick: n,
      dotted: n,
      alphaColors: n,
      icons: n,
      animations: n,
      styleKeys: ['stroke'],
      leftovers: ['classDef hot fill:red'],
      settings: true,
    });
    expect(lines[0]).toBe(
      `${n} node${n === 1 ? '' : 's'}, ${n} link${n === 1 ? '' : 's'} and ${n} group${n === 1 ? '' : 's'} become a new whiteboard.`,
    );
    expect(lines.join('\n')).toContain(
      `${n} invisible link${n === 1 ? ' was a layout hint and was' : 's were layout hints and were'} left out.`,
    );
    expect(lines.join('\n')).toContain(`diamond ×${n}`);
    expect(lines.join('\n')).toContain('classDef hot fill:red');
    expect(lines.at(-1)).toBe('The .mmd file stays where it is, unchanged.');
  });
});
