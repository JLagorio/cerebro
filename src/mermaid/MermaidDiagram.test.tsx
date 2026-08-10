import { useMemo, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MermaidDiagram } from './MermaidDiagram';
import { renderMermaid } from './render';

vi.mock('./render', () => ({
  renderMermaid: vi.fn(),
}));
const renderMock = vi.mocked(renderMermaid);

describe('MermaidDiagram', () => {
  it('renders the svg once the service resolves', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="a"></svg>' });
    render(<MermaidDiagram code={'graph TD\n  A --> B'} />);
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-diagram').innerHTML).toContain('data-fake="a"'),
    );
  });

  it('shows the error card with message and source on failure', async () => {
    renderMock.mockResolvedValue({ ok: false, message: 'Parse error on line 2:', line: 2 });
    render(<MermaidDiagram code={'graph TD\n  A -->'} />);
    await waitFor(() => expect(screen.getByTestId('mermaid-error')).toBeTruthy());
    expect(screen.getByTestId('mermaid-error').textContent).toContain('Parse error on line 2:');
    expect(screen.getByTestId('mermaid-error').textContent).toContain('A -->');
  });

  it('offers Expand only when a handler is given, and passes the svg', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="b"></svg>' });
    const onExpand = vi.fn();
    const { rerender } = render(<MermaidDiagram code="graph TD" onExpand={onExpand} />);
    await waitFor(() => screen.getByTestId('mermaid-diagram'));
    await userEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    expect(onExpand).toHaveBeenCalledWith('<svg data-fake="b"></svg>');

    rerender(<MermaidDiagram code="graph TD" />);
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull();
  });

  it('makes the error card clickable only when onErrorClick is given', async () => {
    renderMock.mockResolvedValue({ ok: false, message: 'Parse error on line 2:', line: 2 });
    const onErrorClick = vi.fn();
    const { rerender } = render(
      <MermaidDiagram code={'graph TD\n  A -->'} onErrorClick={onErrorClick} />,
    );
    await waitFor(() => expect(screen.getByTestId('mermaid-error')).toBeTruthy());
    await userEvent.click(screen.getByRole('button'));
    expect(onErrorClick).toHaveBeenCalled();

    rerender(<MermaidDiagram code={'graph TD\n  A -->'} />);
    await waitFor(() => expect(screen.getByTestId('mermaid-error')).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/**
 * The doc-canvas view injects mermaid's svg straight into the page, and a
 * hand-written `click A "notes/x.md"` line makes that svg carry a real anchor
 * even at securityLevel 'strict' (measured in svgLinks.mermaid.test.ts).
 * Following it inside the Tauri webview takes the whole app off the SPA.
 */
describe('MermaidDiagram cannot navigate the app away (M29.38)', () => {
  const linked = (gen: string, target: string): string =>
    `<svg data-gen="${gen}"><g class="nodes">` +
    `<a href="${target}" data-look="classic"><g class="node clickable"/></a>` +
    `<a xlink:href="${target}"><g class="node clickable"/></a></g></svg>`;

  const liveTargets = (root: ParentNode): string[] =>
    [...root.querySelectorAll('a')].flatMap((a) =>
      [...a.attributes].filter((at) => at.localName === 'href').map((at) => at.value),
    );

  it('strips every link target — on the first render AND on the next one', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: linked('1', 'notes/a.md') });
    const { rerender } = render(<MermaidDiagram code={'graph TD\n  A --> B'} />);
    const view = await screen.findByTestId('mermaid-diagram');
    await waitFor(() => expect(view.querySelector('svg')?.getAttribute('data-gen')).toBe('1'));
    expect(view.querySelectorAll('a')).toHaveLength(2);
    expect(liveTargets(view)).toEqual([]);

    // A diagram re-renders whenever its code changes, and React writes the
    // whole subtree again — restoring the anchors a mount-only fix stripped.
    renderMock.mockResolvedValue({ ok: true, svg: linked('2', 'https://example.com/') });
    rerender(<MermaidDiagram code={'graph TD\n  A --> C'} />);
    await waitFor(() => expect(view.querySelector('svg')?.getAttribute('data-gen')).toBe('2'));
    expect(liveTargets(view)).toEqual([]);
  });
});

/**
 * View mode is not a lesser citizen: a manual-layout diagram that only honoured
 * its stored positions inside the structural editor would snap back to auto
 * geometry every time the block was deselected, and on every reload.
 */
describe('MermaidDiagram honours stored manual positions (M29.42)', () => {
  const MANUAL_SVG = [
    '<svg viewBox="0 0 200 100" width="100%" style="max-width: 200px;">',
    '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
    '<g class="node" id="flowchart-B-1" transform="translate(130, 70)"><rect/></g>',
    '<path class="flowchart-link" id="L_A_B_0" data-id="L_A_B_0"',
    ' d="M30,25C60,40 90,50 120,65" marker-end="url(#e)"/>',
    '</svg>',
  ].join('');

  // The component measures inside its own layout effect, before a test can
  // reach any element, so the stub has to be on the prototype and keyed.
  function withStubbedRects(run: () => Promise<void>): Promise<void> {
    const rects: Record<string, { left: number; top: number; width: number; height: number }> = {
      svg: { left: 0, top: 0, width: 200, height: 100 },
      'flowchart-A-0': { left: 20, top: 10, width: 20, height: 20 },
      'flowchart-B-1': { left: 120, top: 60, width: 20, height: 20 },
    };
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const key = this.tagName.toLowerCase() === 'svg' ? 'svg' : this.id;
      const r = rects[key] ?? { left: 0, top: 0, width: 0, height: 0 };
      return {
        ...r,
        right: r.left + r.width,
        bottom: r.top + r.height,
        x: r.left,
        y: r.top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    // A leaked prototype stub poisons every later test in the file.
    return run().finally(() => {
      Element.prototype.getBoundingClientRect = original;
    });
  }

  it('applies stored positions, straightens the edge, and grows the viewBox', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: MANUAL_SVG });
    await withStubbedRects(async () => {
      render(
        <MermaidDiagram
          code={
            'flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 280,20\n  A[Start] --> B[End]'
          }
        />,
      );
      await waitFor(() => {
        expect(document.getElementById('flowchart-A-0')?.getAttribute('transform')).toBe(
          'translate(30, 20) translate(250, 0)',
        );
      });
      const edge = document.getElementById('L_A_B_0');
      // A is now RIGHT of B: dx=-150 dy=50 -> s=min(10/150, 10/50)=1/15.
      expect(edge?.getAttribute('d')).toBe('M270,23.33L140,66.67');
      expect(edge?.getAttribute('marker-end')).toBe('url(#e)');
      // Without this the node is not merely clipped, it VANISHES (M29.40).
      const svg = document.querySelector('[data-testid="mermaid-diagram"] svg');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 298 100');
      expect((svg as SVGSVGElement | null)?.style.maxWidth).toBe('298px');
    });
  });

  it('leaves an auto-layout diagram exactly as mermaid drew it', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: MANUAL_SVG });
    await withStubbedRects(async () => {
      render(<MermaidDiagram code={'flowchart TD\n  A[Start] --> B[End]'} />);
      await waitFor(() =>
        expect(screen.getAllByTestId('mermaid-diagram').length).toBeGreaterThan(0),
      );
      expect(document.getElementById('flowchart-A-0')?.getAttribute('transform')).toBe(
        'translate(30, 20)',
      );
      expect(document.getElementById('L_A_B_0')?.getAttribute('d')).toBe(
        'M30,25C60,40 90,50 120,65',
      );
    });
  });
});

/**
 * Rendering is ASYNC, so `code` and the svg in the DOM disagree for a window on
 * every edit — and manual layout reads positions out of one and writes them
 * onto the other. They have to travel as a pair.
 */
describe('MermaidDiagram applies the code that produced the svg (M29.42)', () => {
  const SVG_1 = [
    '<svg viewBox="0 0 200 100" width="100%" style="max-width: 200px;">',
    '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
    '<g class="node" id="flowchart-B-1" transform="translate(130, 70)"><rect/></g>',
    '<path class="flowchart-link" id="L_A_B_0" data-id="L_A_B_0"',
    ' d="M30,25C60,40 90,50 120,65" marker-end="url(#e)"/>',
    '</svg>',
  ].join('');
  const SVG_2 = SVG_1.replace('<svg ', '<svg data-gen="2" ');
  const at = (x: number): string =>
    `flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A ${x},20\n  A[Start] --> B[End]`;
  const edgeD = (): string | null | undefined =>
    document.getElementById('L_A_B_0')?.getAttribute('d');

  it('does not place a newer code onto the svg still on screen', async () => {
    const rects: Record<string, { left: number; top: number; width: number; height: number }> = {
      svg: { left: 0, top: 0, width: 200, height: 100 },
      'flowchart-A-0': { left: 20, top: 10, width: 20, height: 20 },
      'flowchart-B-1': { left: 120, top: 60, width: 20, height: 20 },
    };
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const key = this.tagName.toLowerCase() === 'svg' ? 'svg' : this.id;
      const r = rects[key] ?? { left: 0, top: 0, width: 0, height: 0 };
      return {
        ...r,
        right: r.left + r.width,
        bottom: r.top + r.height,
        x: r.left,
        y: r.top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      renderMock.mockResolvedValue({ ok: true, svg: SVG_1 });
      const { rerender } = render(<MermaidDiagram code={at(280)} />);
      await waitFor(() => expect(edgeD()).toBe('M270,23.33L140,66.67'));

      // Hold the next render open: `code` is now the new one, the DOM is still
      // the old one. Keying the pipeline off `code` re-ran it here and drew the
      // new positions onto a picture about to be thrown away — measured, it
      // rewrote the edge to M40,25L120,65 for the length of the window.
      let release: ((r: { ok: true; svg: string }) => void) | null = null;
      renderMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve as typeof release;
          }),
      );
      rerender(<MermaidDiagram code={at(50)} />);
      expect(edgeD()).toBe('M270,23.33L140,66.67');

      await act(async () => {
        release?.({ ok: true, svg: SVG_2 });
      });
      await waitFor(() => expect(edgeD()).toBe('M60,26.25L120,63.75'));
    } finally {
      Element.prototype.getBoundingClientRect = original;
      renderMock.mockReset();
    }
  });

  /**
   * MEASURED on React 19 while fixing the above: `dangerouslySetInnerHTML` is
   * re-applied when the PROP OBJECT changes, not when the html string does, so
   * a fresh object literal per render rebuilt this subtree on every re-render
   * — wiping the manual transforms, and silently restoring the `href`s M29.38
   * strips, which is the older and quieter half of the same hole.
   */
  it('keeps the svg subtree — transforms and stripped links — across a re-render', async () => {
    const withLink = SVG_1.replace(
      '<g class="node" id="flowchart-A-0"',
      '<a href="notes/a.md"><g class="node" id="flowchart-A-0"',
    ).replace('<rect/></g>\n', '<rect/></g></a>');
    renderMock.mockResolvedValue({ ok: true, svg: withLink });
    try {
      const { rerender } = render(<MermaidDiagram code={at(50)} collapseHeight={480} />);
      await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
      const node = document.getElementById('flowchart-A-0')!;
      node.setAttribute('data-probe', 'survives');
      const live = (): string[] =>
        [...document.querySelectorAll('a')].flatMap((a) =>
          [...a.attributes].filter((at2) => at2.localName === 'href').map((at2) => at2.value),
        );
      expect(live()).toEqual([]);

      // Same svg, same code: a parent re-render for any other reason at all.
      rerender(<MermaidDiagram code={at(50)} collapseHeight={481} />);
      expect(document.getElementById('flowchart-A-0')?.getAttribute('data-probe')).toBe('survives');
      expect(live()).toEqual([]);
    } finally {
      renderMock.mockReset();
    }
  });

  /**
   * The CONTROL for the test above, and the end of an argument (M29.49).
   *
   * Two readers have now disagreed about whether the `useMemo` in
   * MermaidDiagram is load-bearing, one of them after probing react-dom and
   * concluding it was not. It is: measured here on react-dom 19.2.8, a fresh
   * `{ __html }` literal with a BYTE-IDENTICAL string re-applies the markup and
   * destroys imperative DOM work, while the memoized prop does not. React
   * compares the prop by IDENTITY and never looks at the string.
   *
   * This uses a bare sink rather than MermaidDiagram because it is a claim
   * about react-dom, not about us — if a future React changes the rule, this
   * fails and the memo's comment is wrong, which is the whole point.
   */
  it('MEASURES react-dom: a fresh raw-html prop object rebuilds, a memoized one does not', () => {
    const HTML = '<svg><a href="notes/a.md"><g /></a></svg>';
    const hrefOf = (id: string): string | null =>
      screen.getByTestId(id).querySelector('a')!.getAttribute('href');

    function Sinks() {
      const [n, bump] = useState(0);
      const stable = useMemo(() => ({ __html: HTML }), []);
      return (
        <>
          <button data-testid="bump" onClick={() => bump(n + 1)}>
            {n}
          </button>
          <div data-testid="fresh-sink" dangerouslySetInnerHTML={{ __html: HTML }} />
          <div data-testid="memo-sink" dangerouslySetInnerHTML={stable} />
        </>
      );
    }

    render(<Sinks />);
    for (const id of ['fresh-sink', 'memo-sink']) {
      screen.getByTestId(id).querySelector('a')!.removeAttribute('href');
    }
    expect(hrefOf('fresh-sink')).toBeNull();
    expect(hrefOf('memo-sink')).toBeNull();

    act(() => {
      screen.getByTestId('bump').click();
    });

    expect(hrefOf('fresh-sink')).toBe('notes/a.md');
    expect(hrefOf('memo-sink')).toBeNull();
  });
});
