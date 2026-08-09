import { render, screen, waitFor } from '@testing-library/react';
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
    await userEvent.dblClick(document.getElementById('flowchart-A-0')!);
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
});
