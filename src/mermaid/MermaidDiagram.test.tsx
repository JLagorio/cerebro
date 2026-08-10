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
