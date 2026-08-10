// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import { fixtureVault, makeEntry } from '@/test/factories';
import { RecordChipOverlay } from './RecordChipOverlay';

/**
 * Two things jsdom cannot give this component, faked precisely rather than
 * mocked away:
 *
 * - **geometry.** `getBoundingClientRect` returns all zeros here, and a chip
 *   test where every number is zero is a test that cannot fail. So the two
 *   elements the measurement actually reads — the chip layer (the origin) and
 *   the bound node's group — get REAL, DIFFERENT rects through a keyed
 *   prototype stub, and the expected `left`/`top` below are the arithmetic
 *   worked by hand.
 * - **the viewport transform.** The overlay reads the live scale to turn
 *   screen deltas into plane units; the mock is the only reason a scale other
 *   than 1 is reachable at all.
 *
 * `bindFlowchartSvg` is NOT mocked. A hand-built svg carrying mermaid's real
 * id scheme (`flowchart-<id>-<counter>`) goes into the fake plane instead, so
 * the binding this overlay depends on is exercised rather than assumed.
 */
const h = vi.hoisted(() => ({
  transform: { current: { scale: 1, offset: { x: 0, y: 0 } } },
  open: vi.fn(),
  modes: [] as (string | undefined)[],
}));

vi.mock('@/mermaid/CanvasViewport', () => ({
  useCanvasTransformRef: () => h.transform,
}));
vi.mock('@/app/useOpenPath', () => ({
  useOpenPath: (mode?: string) => {
    h.modes.push(mode);
    return h.open;
  },
}));

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

const RECTS = new Map<string, DOMRect>();
const NATIVE_RECT = Element.prototype.getBoundingClientRect;

const schema = buildSchema(fixtureVault());
const shipV2 = makeEntry({
  path: 'delivery/ship-v2.md',
  title: 'Ship v2',
  type: 'Work item',
  properties: { status: 'doing' },
});

const CODE = 'flowchart TD\n  a[Ship v2]\n  click a "delivery/ship-v2.md"\n';

/**
 * Hoisted, not a literal in the JSX: a fresh array per render re-memoizes the
 * bindings, which re-arms the measurement effect — and a test meant to prove
 * the plane OBSERVER fires would then pass on the re-render instead. Measured:
 * with a literal here, deleting the observer left the suite green.
 */
const ENTRIES = [shipV2];

/** The transformed plane: the diagram svg and the overlay, as siblings. */
function Plane({ code, withSvg = true }: { code: string; withSvg?: boolean }) {
  return (
    <div data-testid="plane">
      {withSvg && (
        <svg id="cerebro-mermaid-1">
          <g className="node" id="flowchart-a-0" />
        </svg>
      )}
      <RecordChipOverlay code={code} entries={ENTRIES} schema={schema} />
    </div>
  );
}

describe('RecordChipOverlay', () => {
  beforeEach(() => {
    RECTS.clear();
    RECTS.set('[data-testid="whiteboard-chip-layer"]', rect(10, 5, 800, 600));
    RECTS.set('#flowchart-a-0', rect(40, 20, 120, 48));
    h.transform.current = { scale: 1, offset: { x: 0, y: 0 } };
    h.open.mockReset();
    h.modes.length = 0;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      for (const [selector, r] of RECTS) if (this.matches(selector)) return r;
      return rect(0, 0, 0, 0);
    };
  });
  afterEach(cleanup);
  afterAll(() => {
    Element.prototype.getBoundingClientRect = NATIVE_RECT;
  });

  it('draws a chip for each bound node, titled and status-badged', async () => {
    render(<Plane code={CODE} />);
    const chip = await screen.findByTestId('whiteboard-record-chip');
    expect(chip.textContent).toContain('Ship v2');
    expect(chip.textContent).toContain('Doing');
  });

  it('positions the chip in PLANE units — origin subtracted, scale divided', async () => {
    h.transform.current = { scale: 2, offset: { x: 0, y: 0 } };
    render(<Plane code={CODE} />);
    const chip = await screen.findByTestId('whiteboard-record-chip');
    // node (40,20) 120x48 screen, layer origin (10,5), scale 2
    //   → plane x 15, y 7.5, w 60, h 24
    //   → chip anchored at the node's lower edge: left x+4, top y+h-10.
    expect(chip.style.left).toBe('19px');
    expect(chip.style.top).toBe('21.5px');
    expect(chip.style.maxWidth).toBe('140px');
  });

  it('clicking a chip opens the record in place', async () => {
    render(<Plane code={CODE} />);
    await userEvent.click(await screen.findByTestId('whiteboard-record-chip'));
    expect(h.open).toHaveBeenCalledWith('delivery/ship-v2.md');
    // M9.3: the whiteboard IS the backdrop, so the detail panel opens over it
    // rather than the app navigating somewhere to show the record in context.
    expect(h.modes).toContain('in-place');
  });

  it('draws nothing when no click line binds', async () => {
    render(<Plane code={'flowchart TD\n  a[Loose]\n'} />);
    await waitFor(() => expect(screen.queryByTestId('whiteboard-record-chip')).toBeNull());
  });

  it('draws nothing for a bound node the render has not drawn yet', async () => {
    // The binding is real, the svg is not there — a chip floating over an
    // empty plane is worse than a chip that arrives a frame late.
    render(<Plane code={CODE} withSvg={false} />);
    await waitFor(() => expect(screen.queryByTestId('whiteboard-record-chip')).toBeNull());
  });

  it('picks the chip up when the async render lands after mount', async () => {
    // Mermaid renders off the main path and the structural editor writes the
    // svg IMPERATIVELY into the plane, long after this component mounted. So
    // the svg goes in the same way here — no React render happens, and the
    // plane observer is the only thing that can notice. Without it the chips
    // would never appear for the first render of a canvas.
    render(<Plane code={CODE} withSvg={false} />);
    await waitFor(() => expect(screen.queryByTestId('whiteboard-record-chip')).toBeNull());
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'cerebro-mermaid-1';
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    node.setAttribute('class', 'node');
    node.id = 'flowchart-a-0';
    svg.appendChild(node);
    screen.getByTestId('plane').appendChild(svg);
    expect(await screen.findByTestId('whiteboard-record-chip')).toBeTruthy();
  });

  it('says so when an unowned click line contests the binding', async () => {
    render(
      <Plane
        code={`${CODE}  click a href "https://elsewhere.example"\n`}
        // a contested binding still draws — the record is still what this node
        // names — but the chip must not claim the canvas will open it.
      />,
    );
    const chip = await screen.findByTestId('whiteboard-record-chip');
    expect(chip.title).toContain('may open something else');
  });
});
