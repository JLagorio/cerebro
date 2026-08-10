import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FullScreenDiagramEditor } from './FullScreenDiagramEditor';

vi.mock('./render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="f"></svg>' }),
}));
vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue(null),
}));
import { renderMermaid } from './render';
const renderMock = vi.mocked(renderMermaid);

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';
const SEQ = 'sequenceDiagram\n  A->>B: x';

describe('FullScreenDiagramEditor', () => {
  it('a flowchart latches visual: structural editor inside the plane, overlay closed', async () => {
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    const plane = screen.getByTestId('canvas-plane');
    expect(plane.querySelector('[data-testid="structural-host"]')).toBeTruthy();
    // DiagramToolbar owns the controls — the built-in row must not double up.
    expect(screen.queryByTestId('structural-toolbar')).toBeNull();
    expect(screen.queryByTestId('code-overlay')).toBeNull();
    expect(screen.getByTestId('diagram-toolbar')).toBeTruthy();
  });

  it('a non-flowchart latches code: read-only canvas, overlay open, Edit visually absent', async () => {
    render(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain(
        'data-fake="f"',
      ),
    );
    expect(screen.getByTestId('code-overlay')).toBeTruthy();
    expect(screen.queryByTestId('structural-host')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit visually' })).toBeNull();
  });

  it('Show code toggles the overlay, and overlay edits flow out debounced', async () => {
    const onChangeCode = vi.fn();
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={onChangeCode} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const source = screen.getByLabelText('Mermaid source') as HTMLTextAreaElement;
    expect(source.value).toBe(FLOW);
    fireEvent.change(source, { target: { value: `${FLOW}\n  B --> C[More]` } });
    await waitFor(() => expect(onChangeCode).toHaveBeenCalledWith(`${FLOW}\n  B --> C[More]`));
    // Scoped to the toolbar on purpose: with the panel open, CodeOverlay's own
    // close IconButton (M29.25) carries the same accessible name, so an
    // unscoped getByRole matches two buttons and throws.
    await userEvent.click(
      within(screen.getByTestId('diagram-toolbar')).getByRole('button', { name: 'Hide code' }),
    );
    expect(screen.queryByTestId('code-overlay')).toBeNull();
  });

  it('demotes to code when the source stops being a flowchart, and opens the overlay', async () => {
    renderMock.mockClear();
    const { rerender } = render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    rerender(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('code-overlay')).toBeTruthy());
    expect(screen.queryByTestId('structural-host')).toBeNull();
    // Demotion is a PASSIVE effect, so there is one committed frame between
    // the new code arriving and the mode flipping. The `&& flowchartCapable`
    // guard on the visual branch is what keeps StructuralEditor from mounting
    // into it holding model === null — painting its "syntax the visual editor
    // does not own" fallback inside the zoom plane and rendering a face that
    // is already doomed. Exactly one render of the demoted source, not two.
    expect(renderMock.mock.calls.filter((c) => c[0] === SEQ)).toHaveLength(1);
    // Explicit promotion is offered — the latch never promotes on its own.
    rerender(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    expect(screen.queryByTestId('structural-host')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Edit visually' }));
    expect(
      screen.getByTestId('canvas-plane').querySelector('[data-testid="structural-host"]'),
    ).toBeTruthy();
  });

  it('a broken source in code mode keeps the last good svg and names the line', async () => {
    renderMock.mockResolvedValueOnce({ ok: true, svg: '<svg data-fake="good"></svg>' });
    const { rerender } = render(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain('good'),
    );
    renderMock.mockResolvedValueOnce({ ok: false, message: 'Parse error on line 2:', line: 2 });
    rerender(<FullScreenDiagramEditor code={`${SEQ}\n  broken`} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('fullscreen-render-error')).toBeTruthy());
    expect(screen.getByTestId('fullscreen-render-error').textContent).toContain('Line 2:');
    expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain('good');
  });

  it('renders a host overlay inside the plane, not outside it', () => {
    // INSIDE canvas-plane is the whole contract (spec D1): a host positions
    // its overlay in plane units, which only means anything for a node that
    // scales and translates with the plane.
    render(
      <FullScreenDiagramEditor
        code={FLOW}
        onChangeCode={() => {}}
        overlay={<div data-testid="host-overlay" />}
      />,
    );
    expect(
      screen.getByTestId('canvas-plane').querySelector('[data-testid="host-overlay"]'),
    ).toBeTruthy();
  });

  it('renders the title when a host passes one', () => {
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} title="Pipeline" />);
    expect(screen.getByText('Pipeline')).toBeTruthy();
  });
});

/**
 * The read-only face carries `[&_svg]:pointer-events-none`, but that is a
 * hit-testing property for panning — it stops a MOUSE and nothing else, while
 * an SVG `<a href>` is keyboard-focusable and activates on Enter. The target
 * itself has to go (M29.38).
 */
describe('FullScreenDiagramEditor read-only face cannot navigate the app away (M29.38)', () => {
  const linked = (gen: string, target: string): string =>
    `<svg data-gen="${gen}"><g class="nodes">` +
    `<a href="${target}"><g class="node clickable"/></a>` +
    `<a xlink:href="${target}"><g class="node clickable"/></a></g></svg>`;

  const liveTargets = (root: ParentNode): string[] =>
    [...root.querySelectorAll('a')].flatMap((a) =>
      [...a.attributes].filter((at) => at.localName === 'href').map((at) => at.value),
    );

  it('strips every link target, and again when the source changes', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: linked('1', 'notes/a.md') });
    const { rerender } = render(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    const face = await screen.findByTestId('fullscreen-readonly-diagram');
    await waitFor(() => expect(face.querySelector('svg')?.getAttribute('data-gen')).toBe('1'));
    expect(face.querySelectorAll('a')).toHaveLength(2);
    expect(liveTargets(face)).toEqual([]);

    renderMock.mockResolvedValue({ ok: true, svg: linked('2', 'https://example.com/') });
    rerender(<FullScreenDiagramEditor code={`${SEQ}\n  B->>A: y`} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(
        screen
          .getByTestId('fullscreen-readonly-diagram')
          .querySelector('svg')
          ?.getAttribute('data-gen'),
      ).toBe('2'),
    );
    expect(liveTargets(screen.getByTestId('fullscreen-readonly-diagram'))).toEqual([]);
  });
});
