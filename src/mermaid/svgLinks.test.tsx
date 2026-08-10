import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { neutralizeDiagramLinks, useInertDiagramLinks } from './svgLinks';

/** Every href-ish attribute still on an anchor, whatever its prefix. */
function liveTargets(root: ParentNode): string[] {
  return [...root.querySelectorAll('a')].flatMap((a) =>
    [...a.attributes].filter((at) => at.localName === 'href').map((at) => at.value),
  );
}

/**
 * Parsed the way the app parses it — through the HTML parser, which is what
 * puts `xlink:href` in the XLink namespace rather than leaving it a plain
 * attribute named with a colon.
 */
function host(markup: string): HTMLDivElement {
  const el = document.createElement('div');
  el.insertAdjacentHTML('afterbegin', markup);
  return el;
}

// Both spellings mermaid actually emits (measured in svgLinks.mermaid.test.ts:
// flowchart/classDiagram write `href`, stateDiagram-v2 writes `xlink:href`),
// plus the internal references that must NOT be touched.
const MIXED = [
  '<svg id="cerebro-mermaid-1" viewBox="0 0 100 100">',
  '  <defs><g id="tpl"><rect/></g></defs>',
  '  <g class="nodes">',
  '    <a href="notes/a.md" data-look="classic">',
  '      <g class="node default clickable" id="flowchart-A-0"><rect/></g>',
  '    </a>',
  '    <a xlink:href="notes/b.md">',
  '      <g class="node statediagram-state" id="flowchart-B-1"><rect/></g>',
  '    </a>',
  '    <a href="https://example.com/" xlink:href="https://example.com/">',
  '      <text class="actor">Alice</text>',
  '    </a>',
  '    <use href="#tpl" xlink:href="#tpl" />',
  '    <image href="data:image/png;base64,AA" xlink:href="data:image/png;base64,AA" />',
  '  </g>',
  '</svg>',
].join('\n');

describe('neutralizeDiagramLinks (M29.38)', () => {
  it('the fixture is a real one — every target is live before the strip', () => {
    const el = host(MIXED);
    expect(liveTargets(el)).toEqual([
      'notes/a.md',
      'notes/b.md',
      'https://example.com/',
      'https://example.com/',
    ]);
  });

  it('takes the target off every anchor, in either spelling', () => {
    const el = host(MIXED);
    neutralizeDiagramLinks(el);
    expect(liveTargets(el)).toEqual([]);
    expect(el.querySelectorAll('a[href]')).toHaveLength(0);
    // The one an `a[href]` selector alone would have left navigable.
    expect(el.querySelectorAll('a')[1].hasAttribute('xlink:href')).toBe(false);
  });

  it('leaves the anchors themselves, and everything they wrap, in place', () => {
    const el = host(MIXED);
    const anchors = [...el.querySelectorAll('a')];
    const wrapped = anchors.map((a) => a.firstElementChild);
    neutralizeDiagramLinks(el);
    // Same elements, same parents: removing an anchor would reparent the very
    // node groups the structural editor binds handlers to.
    expect([...el.querySelectorAll('a')]).toEqual(anchors);
    expect(anchors.map((a) => a.firstElementChild)).toEqual(wrapped);
    expect(el.querySelector('a')?.getAttribute('data-look')).toBe('classic');
  });

  it('does not touch href on anything that is not an anchor', () => {
    const el = host(MIXED);
    neutralizeDiagramLinks(el);
    const use = el.querySelector('use')!;
    expect(use.getAttribute('href')).toBe('#tpl');
    expect(use.getAttribute('xlink:href')).toBe('#tpl');
    // An icon shape's embedded bitmap is not navigation either.
    expect(el.querySelector('image')?.getAttribute('href')).toBe('data:image/png;base64,AA');
  });

  it('is idempotent, and says nothing when there is nothing to say', () => {
    const el = host(MIXED);
    neutralizeDiagramLinks(el);
    neutralizeDiagramLinks(el);
    expect(liveTargets(el)).toEqual([]);
    expect(() => neutralizeDiagramLinks(null)).not.toThrow();
    expect(() => neutralizeDiagramLinks(undefined)).not.toThrow();
    expect(() => neutralizeDiagramLinks(host('<svg></svg>'))).not.toThrow();
  });
});

function Sink({ svg }: { svg: string }) {
  const ref = useInertDiagramLinks<HTMLDivElement>(svg);
  return <div data-testid="sink" ref={ref} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** The same sink with no hook — the control that keeps the assertions honest. */
function RawSink({ svg }: { svg: string }) {
  return <div data-testid="sink" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const linked = (gen: string, target: string): string =>
  `<svg data-gen="${gen}"><g class="nodes"><a href="${target}"><g class="node"/></a>` +
  `<a xlink:href="${target}"><g class="node"/></a></g></svg>`;

describe('useInertDiagramLinks (M29.38)', () => {
  it('strips on mount and again every time React rewrites the subtree', () => {
    const { rerender } = render(<Sink svg={linked('1', 'notes/a.md')} />);
    const sink = screen.getByTestId('sink');
    expect(sink.querySelectorAll('a')).toHaveLength(2);
    expect(liveTargets(sink)).toEqual([]);

    // The case a mount-only fix gets wrong: a new svg means React sets the
    // markup again, which restores the anchors the last pass had stripped.
    rerender(<Sink svg={linked('2', 'notes/b.md')} />);
    expect(sink.querySelector('svg')?.getAttribute('data-gen')).toBe('2');
    expect(liveTargets(sink)).toEqual([]);

    rerender(<Sink svg={linked('3', 'https://example.com/')} />);
    expect(sink.querySelector('svg')?.getAttribute('data-gen')).toBe('3');
    expect(liveTargets(sink)).toEqual([]);
  });

  it('and the same sink without the hook is navigable — the test is not vacuous', () => {
    render(<RawSink svg={linked('1', 'notes/a.md')} />);
    expect(liveTargets(screen.getByTestId('sink'))).toEqual(['notes/a.md', 'notes/a.md']);
  });
});
