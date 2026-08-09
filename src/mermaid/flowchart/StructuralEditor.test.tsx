import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StructuralEditor } from './StructuralEditor';

// vi.mock factories run during static import resolution — before this
// module's own top-level consts would otherwise initialize — so the fixture
// has to be declared through vi.hoisted() to exist by the time the factory
// (which eagerly evaluates mockResolvedValue's argument) runs.
const { FIXTURE_SVG } = vi.hoisted(() => ({
  FIXTURE_SVG: [
    '<svg viewBox="0 0 200 100">',
    '<g class="node" id="flowchart-A-0"><rect width="10" height="10"/></g>',
    '<g class="node" id="flowchart-B-1"><rect width="10" height="10"/></g>',
    '<g class="node" id="flowchart-C-2"><rect width="10" height="10"/></g>',
    '<path class="flowchart-link" id="L_A_B_0"/>',
    '</svg>',
  ].join(''),
}));

vi.mock('../render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: FIXTURE_SVG }),
}));

const CODE = 'flowchart TD\n  A[Start] --> B[End]';

describe('StructuralEditor', () => {
  it('renders the diagram and selects a node on click', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeTruthy();
  });

  it('double-click renames through a surgical text edit', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeTruthy();
    // Re-fetch from the live document rather than reusing the element handle
    // from before the click: if the svg subtree were React-diffed instead of
    // an imperative sink, the click's setState would re-render and replace
    // this node wholesale, orphaning the handlers bindFlowchartSvg attached
    // and silently dropping this dblclick on a detached element.
    const liveNode = document.getElementById('flowchart-A-0')!;
    await userEvent.dblClick(liveNode);
    const input = screen.getByLabelText('Node label');
    await userEvent.clear(input);
    await userEvent.type(input, 'Kickoff{Enter}');
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Kickoff] --> B[End]');
  });

  it('delete removes the selected node and its edges', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-B-1')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-B-1')!);
    await userEvent.click(screen.getByRole('button', { name: 'Delete node' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start]');
  });

  it('add-connected appends a node and an edge', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Add connected node' }));
    const call = onChangeCode.mock.calls[0][0] as string;
    expect(call).toContain('n1[New step]');
    expect(call).toContain('A --> n1');
  });

  it('a stale selection cannot resurrect a node an external edit deleted', async () => {
    const onChangeCode = vi.fn();
    const { rerender } = render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-B-1')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-B-1')!);
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeTruthy();

    // An external edit (undo, another surface, code-mode) removes B from the
    // diagram entirely while it was still selected here.
    rerender(<StructuralEditor code={'flowchart TD\n  A[Start]'} onChangeCode={onChangeCode} />);

    // The stale selection must not survive: no toolbar to click, and nothing
    // it could still reach (shape/add/delete) is on screen to resurrect B.
    await waitFor(() => expect(screen.queryByTestId('mermaid-node-toolbar')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Delete node' })).toBeNull();
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  it('drag from node to node draws a new edge', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  C[Loose]'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    const a = document.getElementById('flowchart-A-0')!;
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 60, pointerId: 1 });
    // Drop target resolution uses elementFromPoint — stub it to the C node.
    const c = document.getElementById('flowchart-C-2');
    document.elementFromPoint = () => c;
    fireEvent.pointerUp(window, { clientX: 60, clientY: 60, pointerId: 1 });
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start] --> B[End]\n  C[Loose]\n  A --> C',
    );
  });

  it('clicking an edge opens its editor; saving sets the label, delete removes it', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);
    const label = screen.getByLabelText('Edge label');
    await userEvent.type(label, 'go{Enter}');
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start] -->|go| B[End]');

    await userEvent.click(document.getElementById('L_A_B_0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Delete edge' }));
    expect(onChangeCode).toHaveBeenLastCalledWith('flowchart TD\n  A[Start]\n  B[End]');
  });

  it('Enter on an unchanged edge label is a no-op — no history churn', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);
    // Opens with an empty value (this edge starts unlabeled) — commit
    // without typing anything.
    await userEvent.type(screen.getByLabelText('Edge label'), '{Enter}');
    expect(onChangeCode).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Edge label')).toBeNull();
  });

  it('direction buttons rewrite the header only', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await userEvent.click(screen.getByRole('button', { name: 'Direction LR' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart LR\n  A[Start] --> B[End]');
  });

  it('layout toggle writes the elk frontmatter', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await userEvent.click(screen.getByRole('button', { name: 'Layout: Dagre' }));
    expect(onChangeCode.mock.calls[0][0]).toContain('layout: elk');
  });
});
