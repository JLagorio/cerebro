import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StructuralEditor } from './StructuralEditor';

// vi.mock factories run during static import resolution — before this
// module's own top-level consts would otherwise initialize — so the fixture
// has to be declared through vi.hoisted() to exist by the time the factory
// (which eagerly evaluates mockResolvedValue's argument) runs.
const { FIXTURE_SVG, ANIMATED_SVG } = vi.hoisted(() => {
  const nodeEls = [
    '<g class="node" id="flowchart-A-0"><rect width="10" height="10"/></g>',
    '<g class="node" id="flowchart-B-1"><rect width="10" height="10"/></g>',
    '<g class="node" id="flowchart-C-2"><rect width="10" height="10"/></g>',
  ].join('');
  return {
    FIXTURE_SVG: `<svg viewBox="0 0 200 100">${nodeEls}<path class="flowchart-link" id="L_A_B_0"/></svg>`,
    // A user-authored edge id renders VERBATIM as the path's own DOM id and
    // the `L_<from>_<to>_<n>` path is not emitted at all (getEdgeId,
    // utils.ts:946 — see svgBinding.ts). Carrying both here would let the
    // animate toggle "prove" two-way behavior against a binding real mermaid
    // never produces.
    ANIMATED_SVG: `<svg viewBox="0 0 200 100">${nodeEls}<path class="flowchart-link" id="e1"/></svg>`,
  };
});

vi.mock('../render', () => ({
  renderMermaid: vi.fn((code: string) =>
    Promise.resolve({ ok: true, svg: code.includes('e1@') ? ANIMATED_SVG : FIXTURE_SVG }),
  ),
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

  it('the shape palette writes shape data for exotic shapes', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Cloud' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start] --> B[End]\n  A@{ shape: cloud }',
    );
  });

  it('the palette marks the shape the node already renders as', async () => {
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  A@{ shape: cloud }'}
        onChangeCode={() => {}}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    expect(screen.getByRole('button', { name: 'Shape: Cloud' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // A classic-8 node reads through its brackets, with no meta line at all.
    expect(
      screen.getByRole('button', { name: 'Shape: Rectangle' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('the shape trigger announces the popover it owns', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    const trigger = screen.getByRole('button', { name: 'Change shape' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Change shape' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('picking the shape the node already has costs no undo step', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  A@{ shape: database }'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    const database = screen.getByRole('button', { name: 'Shape: Database' });
    expect(database.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(database);
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  it('an opaque multi-line meta block disables the shape edit rather than lying', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  A@{\n    shape: cloud\n  }'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Circle' }));
    // No invented `A((A))` line, and no undo step for an edit that could not
    // have moved anything.
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  it('the color menu writes a style line', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node colors' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fill #eef1fe' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start] --> B[End]\n  style A fill:#eef1fe',
    );
  });

  // Two popovers now hang off ONE toolbar, and Popover's click-away treats
  // any press inside its anchor — which is the whole toolbar — as its own. So
  // nothing dismissed the first when the second opened, and both floated at
  // the same z-index on top of each other.
  it('opening one node popover closes the others', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node colors' }));
    expect(screen.getByTestId('node-style-menu')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    expect(screen.queryByTestId('node-style-menu')).toBeNull();
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    expect(screen.queryByTestId('shape-palette')).toBeNull();
    expect(screen.getByTestId('mermaid-icon-picker')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Node colors' }));
    expect(screen.queryByTestId('mermaid-icon-picker')).toBeNull();
    expect(screen.getByTestId('node-style-menu')).toBeTruthy();
  });

  // A portal bubbles through the REACT tree, so a keystroke inside either
  // popover reaches the editor's own onKeyDown — where Backspace deletes the
  // selected node. Tab into the colour menu, press Backspace, and the node you
  // were about to colour was gone.
  it('Backspace inside a node popover does not delete the node', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);

    await userEvent.click(screen.getByRole('button', { name: 'Node colors' }));
    screen.getByRole('button', { name: 'Fill #f6f7fa' }).focus();
    await userEvent.keyboard('{Backspace}');
    await userEvent.keyboard('{Delete}');
    expect(onChangeCode).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    screen.getByRole('button', { name: 'Shape: Cloud' }).focus();
    await userEvent.keyboard('{Backspace}');
    await userEvent.keyboard('{Delete}');
    expect(onChangeCode).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    screen.getByRole('button', { name: 'Icon rocket' }).focus();
    await userEvent.keyboard('{Backspace}');
    await userEvent.keyboard('{Delete}');
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  it('the color trigger announces the popover it owns', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    const trigger = screen.getByRole('button', { name: 'Node colors' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Node colors' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  // Two style lines for one id: mermaid folds them per key with the LAST value
  // winning, so the menu must mark what renders and write where it renders.
  // Marking (or writing to) the first line is a silent no-op on screen.
  it('the menu marks the color that renders and rewrites that declaration', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  style A fill:#f6f7fa\n  style A fill:#de3b4e'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node colors' }));
    expect(screen.getByRole('button', { name: 'Fill #de3b4e' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Fill #f6f7fa' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fill #eef1fe' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start] --> B[End]\n  style A fill:#f6f7fa\n  style A fill:#eef1fe',
    );
  });

  it('re-picking the color the node already has costs no undo step, and still closes', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  style A fill: #eef1fe'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node colors' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fill #eef1fe' }));
    expect(onChangeCode).not.toHaveBeenCalled();
    // A press that changes nothing is still a press: it dismisses.
    expect(screen.queryByTestId('node-style-menu')).toBeNull();
  });

  it('the icon picker writes an icon meta line', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    await userEvent.click(screen.getByRole('button', { name: 'Icon rocket' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start] --> B[End]\n  A@{ icon: "lucide:rocket", form: rounded, pos: b }',
    );
  });

  // Several meta lines fold per key with the LAST value winning (measured,
  // icons.mermaid.test.ts), so the picker must mark what RENDERS — reading the
  // first line would light up an icon the diagram does not show.
  it('the picker marks the icon that renders, and clearing strips every site', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={
          'flowchart TD\n  A[Start] --> B[End]\n  A@{ icon: "lucide:zap" }\n  A@{ icon: "lucide:rocket" }'
        }
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    expect(screen.getByRole('button', { name: 'Icon rocket' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Icon zap' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove icon' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start] --> B[End]');
  });

  it('the icon trigger announces the popover it owns', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    const trigger = screen.getByRole('button', { name: 'Node icon' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Node icon' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('re-picking the icon the node already has costs no undo step, and still closes', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  A@{ icon: "lucide:rocket" }'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    await userEvent.click(screen.getByRole('button', { name: 'Icon rocket' }));
    expect(onChangeCode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mermaid-icon-picker')).toBeNull();
  });

  it('the icon picker opens with its search box focused, like the shape palette', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search icons');
  });

  it('the color menu opens with a swatch focused, like the shape palette', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node colors' }));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Fill #f6f7fa');
  });

  it('edge controls rewrite head, stroke, and animation surgically', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);

    // The cycle moves arrow → open.
    await userEvent.click(screen.getByRole('button', { name: 'Arrow head: Arrow' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start] --- B[End]');

    await userEvent.click(document.getElementById('L_A_B_0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Stroke thick' }));
    expect(onChangeCode).toHaveBeenLastCalledWith('flowchart TD\n  A[Start] ==> B[End]');

    await userEvent.click(document.getElementById('L_A_B_0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Animate edge' }));
    const animated = onChangeCode.mock.lastCall?.[0] as string;
    expect(animated).toContain('A[Start] e1@--> B[End]');
    expect(animated).toContain('e1@{ animate: true }');
  });

  // The toggle has to come back OFF from the canvas, which is only possible
  // because M29.31 taught svgBinding to match a user-authored edge id: minting
  // `e1` renames the path from `L_A_B_0` to `e1`, and before that fix the very
  // edge you had just animated stopped being clickable.
  it('the animate toggle is two-way from the canvas', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] e1@--> B[End]\n  e1@{ animate: true }'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('e1')).not.toBeNull());
    expect(document.getElementById('L_A_B_0')).toBeNull();
    await userEvent.click(document.getElementById('e1')!);
    const toggle = screen.getByRole('button', { name: 'Animate edge' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(toggle);
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start] e1@--> B[End]');
  });

  // Half one of the leak M29.33's review measured: the edge editor is not a
  // Popover and had no key guard of its own, so Backspace on any of its four
  // controls travelled up to the editor's own onKeyDown — which deletes the
  // SELECTED NODE. (`Delete edge` leaked the same way before E5 ever existed.)
  // The spy stands in for that ancestor handler: nothing typed in here may
  // reach it at all.
  it('keys pressed inside the edge editor never reach the canvas', async () => {
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <StructuralEditor code={CODE} onChangeCode={() => {}} />
      </div>,
    );
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);
    for (const name of ['Stroke thick', 'Animate edge', 'Delete edge']) {
      screen.getByRole('button', { name }).focus();
      await userEvent.keyboard('{Backspace}{Delete}');
    }
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  // Half two: an edge click clears the selection, but a node click never
  // cleared the edge editor — so both surfaces sat open at once, which is the
  // state that made the leak above reachable in the first place.
  it('clicking a node closes the edge editor', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);
    expect(screen.getByLabelText('Edge label')).toBeTruthy();
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    expect(screen.queryByLabelText('Edge label')).toBeNull();
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeTruthy();
  });

  // An & group expands to several edges but the segment carries only ONE id,
  // and upstream gives it to the last start × the first end — so setEdgeAnimate
  // refuses every other expansion. Rendering the button anyway made a control
  // that swallowed the click and closed, which is indistinguishable from broken.
  it('the animate toggle disables itself where an id cannot be carried', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={'flowchart TD\n  A & Z --> B'} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);
    const toggle = screen.getByRole('button', { name: 'Animate edge' });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.getAttribute('title')).toContain('&');
    await userEvent.click(toggle);
    expect(onChangeCode).not.toHaveBeenCalled();
    // The controls that DO work on a group edge stay live.
    expect(screen.getByRole('button', { name: 'Stroke thick' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('the animate toggle stays live on an edge that can carry an id', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);
    expect(screen.getByRole('button', { name: 'Animate edge' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  // An author-chosen length is not ours to normalize on a click that picked
  // the stroke the edge is already drawn with.
  it('re-picking the stroke the edge already has costs no undo step', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] ----> B[End]'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
    await userEvent.click(document.getElementById('L_A_B_0')!);
    const solid = screen.getByRole('button', { name: 'Stroke solid' });
    expect(solid.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(solid);
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  it('toolbar={false} hides the built-in control row but keeps the host', async () => {
    render(
      <StructuralEditor code={'flowchart TD\n  A --> B'} onChangeCode={() => {}} toolbar={false} />,
    );
    expect(screen.queryByTestId('structural-toolbar')).toBeNull();
    expect(screen.getByTestId('structural-host')).toBeTruthy();
  });
});
