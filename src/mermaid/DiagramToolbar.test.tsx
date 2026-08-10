import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { DiagramToolbar } from './DiagramToolbar';
import type { FlowchartModel } from './flowchart/model';
import { setNodePosition } from './flowchart/ops';

vi.mock('./render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="t"></svg>' }),
}));
vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue('/tmp/x.png'),
}));
import { copySvg, savePng } from './export';

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';

function mount(overrides: Partial<Parameters<typeof DiagramToolbar>[0]> = {}) {
  const onChangeCode = vi.fn();
  render(
    <DiagramToolbar
      code={FLOW}
      onChangeCode={onChangeCode}
      mode="visual"
      showCode={false}
      onToggleShowCode={() => {}}
      onEditVisually={null}
      {...overrides}
    />,
  );
  return onChangeCode;
}

describe('DiagramToolbar', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  it('direction buttons rewrite the header surgically', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Direction LR' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart LR\n  A[Start] --> B[End]');
  });

  it('the layout menu switches engines through frontmatter', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Layout engine' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'ELK' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A[Start] --> B[End]',
    );
  });

  // MenuItem's `checked` is a rendered check glyph and nothing else — the
  // convention Dagre/ELK already keep — so "is it checked" is measured the only
  // way the DOM offers: the item carries an icon when it is, and none when it
  // is not (it declares no `icon` of its own).
  const checkGlyphs = (item: Element) => item.querySelectorAll('svg').length;

  it('the layout menu turns auto-layout off, showing the state it is in', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Layout engine' }));
    const item = screen.getByRole('menuitem', { name: 'Auto-layout' });
    expect(checkGlyphs(item)).toBe(1); // this source auto-lays out
    await userEvent.click(item);
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  %% cerebro:layout manual\n  A[Start] --> B[End]',
    );
  });

  it('the layout menu turns auto-layout back on without losing the positions', async () => {
    const onChangeCode = mount({
      code: 'flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 80,20\n  A[Start] --> B[End]',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Layout engine' }));
    const item = screen.getByRole('menuitem', { name: 'Auto-layout' });
    expect(checkGlyphs(item)).toBe(0);
    await userEvent.click(item);
    // Only the marker goes; the positions wait for the next time (spec D7).
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  %% cerebro:pos A 80,20\n  A[Start] --> B[End]',
    );
  });

  it('+ Node appends a fresh node line', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Add node' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start] --> B[End]\n  n1[New step]',
    );
  });

  // M29.39 shipped `+ Shape` on the inline block's toolbar only, which left the
  // richer insert on the LESSER surface — the diagram page and the full-screen
  // dialog both mount this toolbar with `StructuralEditor toolbar={false}`, so
  // they had `+ Node` and nothing else.
  it('+ Shape inserts a node of the chosen shape in ONE undo step', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Hexagon' }));
    // addNode + setNodeShape composed into a single emission: one BlockNote
    // history entry, so one Cmd+Z takes the whole insertion back rather than
    // leaving a stray rectangle behind (spec D10).
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    expect(onChangeCode.mock.calls[0][0]).toBe(
      'flowchart TD\n  A[Start] --> B[End]\n  n1{{New step}}',
    );
  });

  it('the insert trigger announces the popover it owns, and toggles it shut', async () => {
    mount();
    const trigger = screen.getByRole('button', { name: '+ Shape' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Shape' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    expect(screen.queryByTestId('shape-palette')).toBeNull();
  });

  it('the insert palette and the layout menu never sit open together', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Layout engine' }));
    expect(screen.getByRole('menu', { name: 'Layout engine' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    expect(screen.queryByRole('menu', { name: 'Layout engine' })).toBeNull();
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Layout engine' }));
    expect(screen.queryByTestId('shape-palette')).toBeNull();
  });

  // The diagram page streams code overlay edits into `code` on every debounce
  // tick, so an external change under an open palette is routine here, not
  // exotic. Same rule the inline editor's four popovers keep.
  it('an external code change closes the insert palette', async () => {
    const onChangeCode = vi.fn();
    const { rerender } = render(
      <DiagramToolbar
        code={FLOW}
        onChangeCode={onChangeCode}
        mode="visual"
        showCode={false}
        onToggleShowCode={() => {}}
        onEditVisually={null}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    rerender(
      <DiagramToolbar
        code={`${FLOW}\n  B --> C[Ship]`}
        onChangeCode={onChangeCode}
        mode="visual"
        showCode={false}
        onToggleShowCode={() => {}}
        onEditVisually={null}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('shape-palette')).toBeNull());
  });

  it('hides the structural cluster over a read-only canvas, shows Edit visually when offered', () => {
    const onEditVisually = vi.fn();
    mount({ code: 'sequenceDiagram\n  A->>B: x', mode: 'code', onEditVisually });
    expect(screen.queryByRole('button', { name: 'Direction TD' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit visually' })).toBeTruthy();
  });

  it('Show code names the closed panel and reports the toggle', async () => {
    const onToggleShowCode = vi.fn();
    mount({ onToggleShowCode });
    expect(screen.queryByRole('button', { name: 'Hide code' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect(onToggleShowCode).toHaveBeenCalledTimes(1);
  });

  it('Show code flips its label with the panel', () => {
    mount({ showCode: true });
    expect(screen.getByRole('button', { name: 'Hide code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show code' })).toBeNull();
  });

  it('Copy SVG renders through the cached service and hands the svg to export', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await vi.waitFor(() =>
      expect(vi.mocked(copySvg)).toHaveBeenCalledWith('<svg data-fake="t"></svg>'),
    );
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('SVG copied');
  });

  it('toasts a specific failure when copy SVG rejects', async () => {
    vi.mocked(copySvg).mockRejectedValueOnce(new Error('denied'));
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('Copy SVG failed');
  });

  it('does not toast success when save PNG resolves null (cancelled)', async () => {
    vi.mocked(savePng).mockResolvedValueOnce(null);
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Save PNG…' }));
    // Give the resolved promise's .then a turn to run, then confirm nothing
    // toasted: `undefined !== null` is what separates a completed copy from a
    // cancelled save, and only this asserts the distinction is still there.
    await waitFor(() => expect(vi.mocked(savePng)).toHaveBeenCalled());
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});

/**
 * `+ Node` and `+ Shape` here are the ONLY node-creation UI on the full-screen
 * surface (that host mounts `StructuralEditor toolbar={false}`), and that is
 * the surface manual layout is actually used on — so both have to route
 * through the editor's placement or every node minted there lands wherever
 * auto layout put it while its neighbours stay pinned (M29.42 review).
 */
describe('DiagramToolbar places new nodes in manual mode', () => {
  const MANUAL = 'flowchart TD\n  %% cerebro:layout manual\n  A[Start] --> B[End]';
  const placerAt = (x: number, y: number) => ({
    current: (model: FlowchartModel, id: string) => setNodePosition(model, id, { x, y }),
  });

  it('+ Node asks the editor beside it for a position', async () => {
    const onChangeCode = mount({ code: MANUAL, placerRef: placerAt(40, 60) });
    await userEvent.click(screen.getByRole('button', { name: 'Add node' }));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    const out = onChangeCode.mock.calls[0][0] as string;
    expect(out).toMatch(/%% cerebro:pos .*n1 40,60/);
  });

  it('+ Shape does too, in the same single edit', async () => {
    const onChangeCode = mount({ code: MANUAL, placerRef: placerAt(40, 60) });
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Hexagon' }));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    const out = onChangeCode.mock.calls[0][0] as string;
    expect(out).toMatch(/%% cerebro:pos .*n1 40,60/);
    expect(out).toContain('n1{{New step}}');
  });

  it('mints a plain node when nothing beside it is measuring (auto mode)', async () => {
    const onChangeCode = mount({ code: MANUAL, placerRef: { current: null } });
    await userEvent.click(screen.getByRole('button', { name: 'Add node' }));
    expect(onChangeCode.mock.calls[0][0]).not.toContain('cerebro:pos');
  });
});
