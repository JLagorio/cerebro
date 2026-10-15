import { expect, it } from 'vitest';
import { measureMermaidBoard } from './measureMermaidBoard';
const code = 'flowchart TD\n%% cerebro:layout manual\nA[One] --> B[Two]';
const fixture =
  '<svg viewBox="0 0 200 100"><g class="root"><g class="nodes"><g class="node" id="flowchart-A-0" transform="translate(30,20)"><rect/></g><g class="node" id="flowchart-B-1" transform="translate(130,70)"><rect/></g></g></g></svg>';
function host() {
  const node = document.createElement('div');
  node.innerHTML = fixture;
  return node;
}
function rect(node: Element, x: number, y: number, width: number, height: number) {
  node.getBoundingClientRect = () =>
    ({
      x,
      y,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
}
it('returns null for missing, non-flowchart, or unmeasurable jsdom renders', () => {
  expect(measureMermaidBoard(null, code)).toBeNull();
  expect(measureMermaidBoard(host(), 'sequenceDiagram')).toBeNull();
  expect(measureMermaidBoard(host(), code)).toBeNull();
});
it('measures fixture SVG boxes in plane units without changing its source', () => {
  const node = host();
  rect(node.querySelector('svg')!, 10, 20, 400, 200);
  rect(node.querySelector('#flowchart-A-0')!, 50, 40, 40, 40);
  rect(node.querySelector('#flowchart-B-1')!, 250, 140, 40, 40);
  const before = [...node.querySelectorAll('g.node')].map((n) => n.getAttribute('transform'));
  expect(measureMermaidBoard(node, code)).toEqual(
    new Map([
      ['A', { x: 20, y: 10, width: 20, height: 20 }],
      ['B', { x: 120, y: 60, width: 20, height: 20 }],
    ]),
  );
  expect([...node.querySelectorAll('g.node')].map((n) => n.getAttribute('transform'))).toEqual(
    before,
  );
  expect(node.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 200 100');
  const page = document.createElement('div');
  page.innerHTML = '<svg aria-hidden="true"><path/></svg>';
  page.append(node);
  expect(measureMermaidBoard(page, code)).toEqual(measureMermaidBoard(node, code));
});
