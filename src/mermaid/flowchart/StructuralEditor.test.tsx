import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { StructuralEditor } from './StructuralEditor';

// vi.mock factories run during static import resolution — before this
// module's own top-level consts would otherwise initialize — so the fixture
// has to be declared through vi.hoisted() to exist by the time the factory
// (which eagerly evaluates mockResolvedValue's argument) runs.
const {
  FIXTURE_SVG,
  ANIMATED_SVG,
  CLUSTERED_SVG,
  NESTED_SVG,
  SLASH_SVG,
  BARE_SVG,
  ICON_SVG,
  override,
} = vi.hoisted(() => {
  const nodeEls = [
    '<g class="node" id="flowchart-A-0"><rect width="10" height="10"/></g>',
    '<g class="node" id="flowchart-B-1"><rect width="10" height="10"/></g>',
    '<g class="node" id="flowchart-C-2"><rect width="10" height="10"/></g>',
  ].join('');
  // Cluster shape MEASURED on the bundled 11.16.0 (subgraphs.mermaid.test.ts):
  // `<g class="cluster" id="<renderId>-<subgraphId>">`, holding its own rect,
  // with node groups in a SIBLING layer rather than inside it.
  const cluster = (id: string): string =>
    `<g class="cluster" id="${id}"><rect width="120" height="80"/></g>`;
  return {
    FIXTURE_SVG: `<svg viewBox="0 0 200 100">${nodeEls}<path class="flowchart-link" id="L_A_B_0"/></svg>`,
    // A user-authored edge id renders VERBATIM as the path's own DOM id and
    // the `L_<from>_<to>_<n>` path is not emitted at all (getEdgeId,
    // utils.ts:946 — see svgBinding.ts). Carrying both here would let the
    // animate toggle "prove" two-way behavior against a binding real mermaid
    // never produces.
    ANIMATED_SVG: `<svg viewBox="0 0 200 100">${nodeEls}<path class="flowchart-link" id="e1"/></svg>`,
    CLUSTERED_SVG: `<svg viewBox="0 0 300 150">${cluster('ops')}${nodeEls}<path class="flowchart-link" id="L_A_B_0"/></svg>`,
    NESTED_SVG: `<svg viewBox="0 0 300 150">${cluster('outer')}${cluster('inner')}${nodeEls}</svg>`,
    SLASH_SVG: `<svg viewBox="0 0 300 150">${cluster('a/b')}${nodeEls}</svg>`,
    // A BARE opener's effective id is its own title text — so the cluster's
    // DOM id is `Operations`, not a generated ordinal.
    BARE_SVG: `<svg viewBox="0 0 300 150">${cluster('Operations')}${nodeEls}<path class="flowchart-link" id="L_A_B_0"/></svg>`,
    // How mermaid REALLY draws a node carrying an icon (MEASURED on the
    // bundled 11.16.0, asserted in icons.mermaid.test.ts): the group's class
    // is `icon-shape default`, not `node`, and its glyph hangs off an inner
    // `icon-shape2` group with no id of its own. A's affordances have to
    // survive that, because the control that removes the icon is one of them.
    ICON_SVG: `<svg viewBox="0 0 200 100"><g class="icon-shape default" id="flowchart-A-0"><rect width="10" height="10"/><g class="icon-shape2"><path/></g></g><g class="node" id="flowchart-B-1"><rect width="10" height="10"/></g><path class="flowchart-link" id="L_A_B_0"/></svg>`,
    /** Which svg the mocked renderer hands back next, when a test pins one. */
    override: { svg: null as string | null },
  };
});

vi.mock('../render', () => ({
  renderMermaid: vi.fn((code: string) =>
    Promise.resolve({
      ok: true,
      svg: override.svg ?? (code.includes('e1@') ? ANIMATED_SVG : FIXTURE_SVG),
    }),
  ),
}));

/** Pin the svg the mocked renderer returns for this test only. */
function mockSvg(svg: string): void {
  override.svg = svg;
}

afterEach(() => {
  override.svg = null;
});

const CODE = 'flowchart TD\n  A[Start] --> B[End]';

/** Minimal Entry shape — only the fields resolveTarget and the popover read. */
const entry = (path: string, title: string, filename: string, folder: string): Entry =>
  ({
    path,
    filename,
    folder,
    project: null,
    title,
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '',
    modifiedAt: '',
    parseError: null,
  }) satisfies Entry;

const ENTRIES: Entry[] = [
  entry('projects/atlas/project.md', 'Atlas', 'project.md', 'projects/atlas'),
  entry('notes/atlas-retro.md', 'Atlas retro', 'atlas-retro.md', 'notes'),
];

const CLUSTERED_CODE = [
  'flowchart TD',
  '  subgraph ops[Operations]',
  '    A[Start] --> B[End]',
  '  end',
  '  C[Lone]',
  '  click C "projects/atlas/project.md"',
].join('\n');

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

  // Render precedence is img > icon > shape (MEASURED, icons.mermaid.test.ts):
  // a node with both draws the icon and the shape never appears. The pick is
  // still retained — it applies the moment the icon goes — so the palette stays
  // live and says so rather than lighting up a shape nothing is drawing.
  it('the shape palette says when an icon out-ranks the shape', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  A@{ shape: cloud, icon: "lucide:rocket" }'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    expect(screen.getByTestId('shape-superseded-note').textContent).toContain('lucide:rocket');
    // Latent, not refused: the pick still lands.
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Database' }));
    expect(onChangeCode.mock.calls[0][0]).toContain('shape: cyl');
  });

  it('toolbar={false} hides the built-in control row but keeps the host', async () => {
    render(
      <StructuralEditor code={'flowchart TD\n  A --> B'} onChangeCode={() => {}} toolbar={false} />,
    );
    expect(screen.queryByTestId('structural-toolbar')).toBeNull();
    expect(screen.getByTestId('structural-host')).toBeTruthy();
  });

  // M29.39: insert-with-a-shape. `+ Node` mints a rectangle; this mints
  // whatever the palette was pointed at, and the two ops travel together.
  it('+ Shape inserts a node of the chosen shape in ONE undo step', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={'flowchart TD\n  A[Start]'} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Hexagon' }));
    // addNode + setNodeShape composed into a single apply: one emission is one
    // BlockNote history entry, so one Cmd+Z takes the whole insertion back
    // rather than leaving a stray rectangle behind (spec D10).
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    const out = onChangeCode.mock.calls[0][0] as string;
    // The brackets, rewritten in place on the line addNode just minted — not a
    // second `@{ shape: hex }` line for a node whose definition we own.
    expect(out).toBe('flowchart TD\n  A[Start]\n  n1{{New step}}');
  });

  // The defect M29.39's e2e found in M29.35's icon control: an icon node is
  // not a `g.node`, so binding on that class alone left the node with no
  // toolbar, no rename, no delete, no badge — and no way back, since "Remove
  // icon" lives behind the selection the icon had just destroyed.
  it('a node mermaid drew as an icon shape is still selectable, and un-iconable', async () => {
    mockSvg(ICON_SVG);
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  A@{ icon: "lucide:rocket" }'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove icon' }));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    expect(onChangeCode.mock.calls[0][0] as string).not.toContain('icon');
  });

  it('the insert trigger announces the popover it owns, and toggles it shut', async () => {
    render(<StructuralEditor code={'flowchart TD\n  A[Start]'} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    const trigger = screen.getByRole('button', { name: '+ Shape' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Shape' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    // The palette's own click-away treats its anchor as inside, so without a
    // toggle here a second press on the trigger would re-open what it just
    // closed and the surface could never be dismissed from the button.
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    expect(screen.queryByTestId('shape-palette')).toBeNull();
  });

  it('opening the insert palette closes a node popover, and vice versa', async () => {
    render(<StructuralEditor code={'flowchart TD\n  A[Start]'} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    expect(screen.getByTestId('mermaid-icon-picker')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    expect(screen.queryByTestId('mermaid-icon-picker')).toBeNull();
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Node icon' }));
    expect(screen.queryByTestId('shape-palette')).toBeNull();
    expect(screen.getByTestId('mermaid-icon-picker')).toBeTruthy();
  });

  // Item 3 of M29.39's review: deleting the reset left every test green. It is
  // belt-and-braces — the palette holds no line indices and onPick closes it —
  // but an EXTERNAL edit (undo, code mode, another surface) redraws the diagram
  // under a surface that is still floating over it, and every other popover
  // here goes on a code change. Now it is a guarantee rather than a habit.
  it('an external code change closes the insert palette', async () => {
    const { rerender } = render(
      <StructuralEditor code={'flowchart TD\n  A[Start]'} onChangeCode={() => {}} />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    rerender(<StructuralEditor code={'flowchart TD\n  A[Renamed]'} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('shape-palette')).toBeNull());
  });

  // Item 2 of the same review: the drag-drop half of the icon-binding fix
  // shipped with nothing proving it. Reverting that one `closest()` selector
  // left all 69 tests green, while the failure it prevents is silent and
  // destructive — the drop misses the node it landed on and mints a stray
  // "New step" plus an edge to it, instead of connecting the two nodes.
  it('dropping an edge onto an ICON node connects it, and does not mint a stray node', async () => {
    mockSvg(ICON_SVG);
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start]\n  B[End]\n  A@{ icon: "lucide:rocket" }'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-B-1')).not.toBeNull());
    const b = document.getElementById('flowchart-B-1')!;
    fireEvent.pointerDown(b, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 60, pointerId: 1 });
    // The drop lands on A — which mermaid drew as `g.icon-shape`, not `g.node`.
    const a = document.getElementById('flowchart-A-0');
    document.elementFromPoint = () => a;
    fireEvent.pointerUp(window, { clientX: 60, clientY: 60, pointerId: 1 });
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start]\n  B[End]\n  A@{ icon: "lucide:rocket" }\n  B --> A',
    );
  });

  it('opening the insert palette and closing it again is a TRUE no-op', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={'flowchart TD\n  A[Start]'} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
    // Asserted BEFORE the Escape: without this the test passes just as well
    // when `+ Shape` has stopped opening anything at all, which is the one
    // regression it would most want to catch.
    expect(screen.getByTestId('shape-palette')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('shape-palette')).toBeNull();
    expect(onChangeCode).not.toHaveBeenCalled();
  });
});

describe('subgraph affordances (M29.38)', () => {
  it('clicking a cluster (not a node inside it) opens the subgraph toolbar', async () => {
    mockSvg(CLUSTERED_SVG);
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    expect(screen.getByTestId('mermaid-subgraph-toolbar')).toBeTruthy();
    // The box opens on the block's own title, so a retitle starts from what is
    // there rather than from empty.
    expect((screen.getByLabelText('Subgraph title') as HTMLInputElement).value).toBe('Operations');
  });

  it('dissolve removes the markers through a surgical edit', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    await userEvent.click(screen.getByRole('button', { name: 'Dissolve subgraph' }));
    const out = onChangeCode.mock.calls[0][0] as string;
    expect(out).not.toContain('subgraph');
    expect(out).toContain('    A[Start] --> B[End]'); // body bytes intact, indentation included
  });

  it('renaming a block through the toolbar keeps its id', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    const title = screen.getByLabelText('Subgraph title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Delivery{Enter}');
    expect(onChangeCode.mock.lastCall?.[0]).toContain('subgraph ops[Delivery]');
  });

  // The fixture is a BARE opener on purpose. `renameSubgraph` re-emits it as
  // the QUOTED `subgraph "Operations"`, so apply's byte guard does NOT catch
  // this one — an explicit `subgraph ops[Operations]` re-emits identically and
  // would let the test pass with the component's own guard deleted.
  it('Enter on an unchanged subgraph title is a no-op — no history churn', async () => {
    mockSvg(BARE_SVG);
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  subgraph Operations\n    A[Start] --> B[End]\n  end'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('Operations')).not.toBeNull());
    await userEvent.click(document.getElementById('Operations')!);
    expect((screen.getByLabelText('Subgraph title') as HTMLInputElement).value).toBe('Operations');
    await userEvent.type(screen.getByLabelText('Subgraph title'), '{Enter}');
    expect(onChangeCode).not.toHaveBeenCalled();
    // …and a real retitle of the same bare block still writes.
    await userEvent.clear(screen.getByLabelText('Subgraph title'));
    await userEvent.type(screen.getByLabelText('Subgraph title'), 'Delivery{Enter}');
    expect(onChangeCode.mock.lastCall?.[0]).toContain('subgraph Operations[Delivery]');
  });

  it('the direction the block already has costs no undo step', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    const code = [
      'flowchart TD',
      '  subgraph ops[Operations]',
      // Deliberately NOT canonical: `setSubgraphDirection` would normalize the
      // spacing, so apply's byte guard cannot catch this one and the
      // component's own no-op guard is what makes the click free.
      '    direction   LR',
      '    A[Start] --> B[End]',
      '  end',
    ].join('\n');
    render(<StructuralEditor code={code} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    const lr = screen.getByRole('button', { name: 'Subgraph direction LR' });
    expect(lr.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(lr);
    expect(onChangeCode).not.toHaveBeenCalled();
    // …and a different one still writes.
    await userEvent.click(screen.getByRole('button', { name: 'Subgraph direction BT' }));
    expect(onChangeCode.mock.calls[0][0]).toContain('direction BT');
  });

  it('shift-clicking two nodes offers Group into subgraph', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor code={'flowchart TD\n  A[One]\n  B[Two]'} onChangeCode={onChangeCode} />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    // fireEvent, not userEvent: userEvent v14 has no per-click modifier option —
    // Shift is keyboard state, and fireEvent states it directly on the
    // MouseEvent, which is exactly what the imperative onclick reads.
    fireEvent.click(document.getElementById('flowchart-A-0')!, { shiftKey: true });
    fireEvent.click(document.getElementById('flowchart-B-1')!, { shiftKey: true });
    expect(screen.getByTestId('mermaid-group-bar').textContent).toContain('2 selected');
    // A shift-click builds a selection; it must not open the single-node toolbar.
    expect(screen.queryByTestId('mermaid-node-toolbar')).toBeNull();
    await userEvent.type(screen.getByLabelText('New subgraph title'), 'Grouped');
    await userEvent.click(screen.getByRole('button', { name: 'Group into subgraph' }));
    const out = onChangeCode.mock.calls[0][0] as string;
    expect(out).toContain('subgraph Grouped[Grouped]');
    expect(out).toContain('end');
  });

  // The two surfaces share the canvas and must never be open together — a
  // cluster click is a fresh selection, and a plain node click drops a pending
  // multi-selection rather than leaving a bar hanging over an unrelated pick.
  it('a cluster click and a plain node click each clear a pending multi-selection', async () => {
    mockSvg(CLUSTERED_SVG);
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    fireEvent.click(document.getElementById('flowchart-A-0')!, { shiftKey: true });
    fireEvent.click(document.getElementById('flowchart-B-1')!, { shiftKey: true });
    expect(screen.getByTestId('mermaid-group-bar')).toBeTruthy();
    await userEvent.click(document.getElementById('ops')!);
    expect(screen.queryByTestId('mermaid-group-bar')).toBeNull();
    expect(screen.getByTestId('mermaid-subgraph-toolbar')).toBeTruthy();

    fireEvent.click(document.getElementById('flowchart-A-0')!, { shiftKey: true });
    fireEvent.click(document.getElementById('flowchart-B-1')!, { shiftKey: true });
    expect(screen.getByTestId('mermaid-group-bar')).toBeTruthy();
    expect(screen.queryByTestId('mermaid-subgraph-toolbar')).toBeNull();
    await userEvent.click(document.getElementById('flowchart-C-2')!);
    expect(screen.queryByTestId('mermaid-group-bar')).toBeNull();
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeTruthy();
  });

  // Carried from the F3 review: these predicates exist so a control can go dead
  // WITH a reason instead of swallowing the click. A disabled control that does
  // not say why is only half a fix.
  it('grouping a node that already belongs to a block is refused, and says why', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    fireEvent.click(document.getElementById('flowchart-A-0')!, { shiftKey: true }); // inside ops
    fireEvent.click(document.getElementById('flowchart-C-2')!, { shiftKey: true }); // outside
    const group = screen.getByRole('button', { name: 'Group into subgraph' });
    expect(group.hasAttribute('disabled')).toBe(true);
    expect(group.getAttribute('title')).toContain('already belongs');
    expect(screen.getByTestId('mermaid-group-bar').textContent).toContain('already belongs');
    await userEvent.click(group);
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  it('dissolving a nested block whose direction would leak is refused, and says why', async () => {
    mockSvg(NESTED_SVG);
    const onChangeCode = vi.fn();
    const code = [
      'flowchart TD',
      '  subgraph outer[Outer]',
      '    subgraph inner[Inner]',
      '      direction LR %% keep this note',
      '      A[Start]',
      '    end',
      '  end',
    ].join('\n');
    render(<StructuralEditor code={code} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('inner')).not.toBeNull());
    await userEvent.click(document.getElementById('inner')!);
    const dissolve = screen.getByRole('button', { name: 'Dissolve subgraph' });
    expect(dissolve.hasAttribute('disabled')).toBe(true);
    expect(dissolve.getAttribute('title')).toContain('re-directing');
    await userEvent.click(dissolve);
    expect(onChangeCode).not.toHaveBeenCalled();
    // The OUTER block has no such line at its own depth and stays live.
    await userEvent.click(document.getElementById('outer')!);
    expect(screen.getByRole('button', { name: 'Dissolve subgraph' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('a blank subgraph title is refused in place rather than emitting a killer line', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    const title = screen.getByLabelText('Subgraph title');
    await userEvent.clear(title);
    expect(screen.getByTestId('mermaid-subgraph-toolbar').textContent).toContain('needs a title');
    expect(title.getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(title, '{Enter}');
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  // `subgraph a/b` really is the id `a/b` (MEASURED, M29.37) and no explicit
  // form can spell it, so any retitle would silently re-key the block.
  it('a retitle that cannot keep an unspellable id is refused, and says why', async () => {
    mockSvg(SLASH_SVG);
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  subgraph a/b\n    A[Start]\n  end'}
        onChangeCode={onChangeCode}
      />,
    );
    await waitFor(() => expect(document.getElementById('a/b')).not.toBeNull());
    await userEvent.click(document.getElementById('a/b')!);
    const title = screen.getByLabelText('Subgraph title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed{Enter}');
    expect(screen.getByTestId('mermaid-subgraph-toolbar').textContent).toContain('id');
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  // A portal is not involved here, but the leak is the same one: Backspace on
  // any control inside an overlay reaches the editor's own onKeyDown, which
  // deletes the SELECTED NODE.
  it('keys pressed inside the subgraph surfaces never reach the canvas', async () => {
    mockSvg(CLUSTERED_SVG);
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <StructuralEditor code={CLUSTERED_CODE} onChangeCode={() => {}} />
      </div>,
    );
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    for (const name of ['Subgraph direction LR', 'Dissolve subgraph']) {
      screen.getByRole('button', { name }).focus();
      await userEvent.keyboard('{Backspace}{Delete}');
    }
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  // The BUTTON, not the title box: the input carries its own stopPropagation,
  // so focusing it proves nothing about the container guard around it — and a
  // selection that REFUSES leaves the button disabled, which dispatches no
  // keystrokes at all. Both mistakes made this test unable to fail.
  it('keys pressed on the group bar itself never reach the canvas', async () => {
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <StructuralEditor
          code={'flowchart TD\n  A[One]\n  B[Two]\n  C[Three]'}
          onChangeCode={() => {}}
        />
      </div>,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    fireEvent.click(document.getElementById('flowchart-A-0')!, { shiftKey: true });
    fireEvent.click(document.getElementById('flowchart-B-1')!, { shiftKey: true });
    const group = screen.getByRole('button', { name: 'Group into subgraph' });
    expect(group.hasAttribute('disabled')).toBe(false);
    group.focus();
    await userEvent.keyboard('{Backspace}{Delete}');
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  // The defect Popover.tsx documents verbatim: "a name typed into a popover's
  // rename box was silently discarded by the very click the user made to accept
  // it". Enter was the only commit, and both ways out of this toolbar threw the
  // typed title away.
  it('a typed subgraph title survives the background click that closes the toolbar', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    const title = screen.getByLabelText('Subgraph title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Delivery');
    await userEvent.click(screen.getByTestId('structural-host'));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    expect(onChangeCode.mock.calls[0][0]).toContain('subgraph ops[Delivery]');
  });

  // A press on a SIBLING control is not leaving the toolbar, so the pending
  // title is folded into that control's own op — one onChangeCode, one undo
  // step, and neither the title nor the click is lost.
  it('a direction click carries the pending title instead of discarding it', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    const title = screen.getByLabelText('Subgraph title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Delivery');
    await userEvent.click(screen.getByRole('button', { name: 'Subgraph direction LR' }));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    const out = onChangeCode.mock.calls[0][0] as string;
    expect(out).toContain('subgraph ops[Delivery]');
    expect(out).toContain('direction LR');
  });

  it('Escape discards the typed title — a cancel stays a cancel', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    const title = screen.getByLabelText('Subgraph title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Delivery{Escape}');
    expect(screen.queryByTestId('mermaid-subgraph-toolbar')).toBeNull();
    expect(onChangeCode).not.toHaveBeenCalled();
  });
});

describe('link affordances (M29.38)', () => {
  it('a linked node shows a badge; clicking a record badge opens in place', async () => {
    mockSvg(CLUSTERED_SVG);
    const onOpenPath = vi.fn();
    render(
      <StructuralEditor code={CLUSTERED_CODE} onChangeCode={() => {}} onOpenPath={onOpenPath} />,
    );
    await waitFor(() => expect(screen.queryByTestId('mermaid-link-badge')).not.toBeNull());
    await userEvent.click(screen.getByTestId('mermaid-link-badge'));
    expect(onOpenPath).toHaveBeenCalledWith('projects/atlas/project.md');
  });

  it('a record badge with no host router is inert rather than a crash', async () => {
    mockSvg(CLUSTERED_SVG);
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('mermaid-link-badge')).not.toBeNull());
    await userEvent.click(screen.getByTestId('mermaid-link-badge'));
    expect(screen.getByTestId('mermaid-link-badge')).toBeTruthy();
  });

  it('a URL badge opens a new window, guarded', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const code = 'flowchart TD\n  A[Start]\n  click A "https://example.com"';
    render(<StructuralEditor code={code} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('mermaid-link-badge')).not.toBeNull());
    await userEvent.click(screen.getByTestId('mermaid-link-badge'));
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('the node toolbar link button binds a record through the popover', async () => {
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start]'}
        onChangeCode={onChangeCode}
        entries={ENTRIES}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node link' }));
    await userEvent.type(screen.getByLabelText('Link target'), 'atlas');
    await userEvent.click(screen.getByRole('button', { name: 'Link to Atlas' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start]\n  click A "projects/atlas/project.md"',
    );
  });

  it('the link popover joins the mutual-close set on the node toolbar', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} entries={ENTRIES} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node link' }));
    expect(screen.getByTestId('mermaid-link-popover')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    expect(screen.queryByTestId('mermaid-link-popover')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Node link' }));
    expect(screen.queryByTestId('shape-palette')).toBeNull();
    expect(screen.getByTestId('mermaid-link-popover')).toBeTruthy();
  });

  it('the link trigger announces the popover it owns', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    const trigger = screen.getByRole('button', { name: 'Node link' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Node link' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('Backspace inside the link popover does not delete the node', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} entries={ENTRIES} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node link' }));
    await userEvent.keyboard('{Backspace}{Delete}');
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  // A LIVE bug this task closes: at securityLevel 'strict' mermaid attaches no
  // click HANDLER but still wraps the node group in a real `<a href>`, and
  // following a link is a DEFAULT ACTION that the node handler's
  // stopPropagation() never touched. Clicking a linked node merely to SELECT it
  // navigated the whole webview off the SPA.
  it('the rendered picture carries no live href for a click to follow', async () => {
    const linked = `<svg viewBox="0 0 200 100"><g class="nodes"><a href="notes/a.md"><g class="node" id="flowchart-A-0"><rect width="10" height="10"/></g></a></g></svg>`;
    mockSvg(linked);
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start]\n  click A "notes/a.md"'}
        onChangeCode={() => {}}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    expect(document.querySelectorAll('a[href]')).toHaveLength(0);
    // Selecting still works, and the badge is the hit target instead.
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeTruthy();
    expect(screen.getByTestId('mermaid-link-badge')).toBeTruthy();
  });

  // The badge's classifier and the popover's are now the same predicate
  // (./linkTargets). A hand-written scheme the editor cannot route is neither a
  // web address nor a vault path, and routing it as a path asked the app to
  // open a doc called `mailto:…`.
  it('a target that is neither a URL nor a vault path disables the badge, and says why', async () => {
    const onOpenPath = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start]\n  click A "mailto:x@y.com"'}
        onChangeCode={() => {}}
        onOpenPath={onOpenPath}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('mermaid-link-badge')).not.toBeNull());
    const badge = screen.getByTestId('mermaid-link-badge');
    expect(badge.hasAttribute('disabled')).toBe(true);
    expect(badge.getAttribute('title')).toContain('cannot open it');
    await userEvent.click(badge);
    expect(onOpenPath).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  // Badges are read off the OLD model and pinned to the OLD picture, and the
  // re-render that replaces them is async — so a badge held across a code
  // change can fire onOpenPath with a deleted node's target.
  it('a code change clears the badges rather than leaving a stale one clickable', async () => {
    const code = 'flowchart TD\n  A[Start] --> B[End]\n  click A "notes/a.md"';
    const { rerender } = render(<StructuralEditor code={code} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('mermaid-link-badge')).not.toBeNull());
    // An external edit (undo, code mode, another surface) deletes A outright.
    rerender(<StructuralEditor code={'flowchart TD\n  B[End]'} onChangeCode={() => {}} />);
    expect(screen.queryByTestId('mermaid-link-badge')).toBeNull();
  });

  // The unparseable-header branch returns BEFORE bindFlowchartSvg, so the strip
  // that lives in the binding never ran on it. Unreachable through today's two
  // hosts — both gate on parseFlowchart(code) !== null — but a hole the moment
  // one mounts this editor ungated.
  it('a diagram the editor cannot model is injected with its anchors already dead', async () => {
    const linked = `<svg viewBox="0 0 200 100"><g class="root"><a xlink:href="notes/a.md"><g class="node"><rect width="10" height="10"/></g></a><a href="https://example.com/"><rect/></a></g></svg>`;
    mockSvg(linked);
    render(<StructuralEditor code={'sequenceDiagram\n  A->>B: hi'} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('structural-host').innerHTML).not.toBe(''));
    // The editor is in its render-only fallback — no model, no binding pass.
    expect(screen.getByText(/syntax the visual editor does not own/)).toBeTruthy();
    expect(document.querySelectorAll('a[href], a[*|href]')).toHaveLength(0);
  });

  // A node linked ONLY by a click form the editor does not own has NO nodeLinks
  // entry, so "absent" must not be read as "unlinked".
  it('a link the editor does not own is reported in the popover', async () => {
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start] --> B[End]\n  click A href "notes/a.md"'}
        onChangeCode={() => {}}
        entries={ENTRIES}
      />,
    );
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Node link' }));
    expect(screen.getByTestId('mermaid-link-contested').textContent).toContain(
      'cannot be edited here',
    );
  });
});
