import { render, screen, waitFor } from '@testing-library/react';
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
