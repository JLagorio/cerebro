# M29 Stage G — Manual Layout: Auto-layout OFF, positions we own, edges we route (M29.40–M29.44)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **THIS STAGE IS SPIKE-GATED.** Task G1 (M29.40) is a time-boxed feasibility spike whose written findings decide whether Tasks G2–G5 execute as specified. If any spike exit criterion fails, the implementer STOPS after committing the findings and reports to the coordinator for a scope decision. Do not silently choose the fallback. Do not silently push through a failed criterion.

**Goal:** A flowchart whose source carries `%% cerebro:layout manual` renders through real mermaid as always — and then WE take over geometry: each node is translated to its stored position (from a `%% cerebro:pos …` comment), every edge we can bind is re-routed as a straight line between node borders with its arrowheads and label intact, and dragging a node writes its new position back into the file as a surgical one-line edit. Toggling auto-layout back on removes the marker, keeps the positions, and hands geometry back to mermaid.

**Architecture:** Everything stays in `src/mermaid/flowchart/`. The model (`model.ts`) gains two understood comment kinds (`pos-comment`, `layout-mode`); `ops.ts` gains `setNodePosition` / `clearPositions` / `setManualLayout`; a new `manualLayout.ts` holds the geometry (border-anchor math, plane↔client conversion, transform application, edge re-routing) as a React-free imperative layer over the bound SVG; `StructuralEditor.tsx` runs the pipeline after render+bind and re-purposes node drag as *move* in manual mode (connect moves to a hover handle); `MermaidDiagram.tsx` runs the same read-only pipeline so view mode honors stored positions too.

**Tech stack:** No new dependencies. No second layout engine, no reactflow — mermaid still renders everything; we post-process its SVG.

**Spec:** `docs/superpowers/specs/2026-08-09-cerebro-m29-wave2-parity-design.md` — decisions D3 (pos-comment kind), D7 (manual layout, built by us, spike-gated), D9 (layout controls), D10 (surgical ops).
**Prerequisites:** Stages A–C (merged in this branch's history: model/ops/svgBinding/StructuralEditor as they exist in the worktree today). Stage D (CanvasViewport / DiagramToolbar) and Stage E (node-meta, style kinds) are scheduled before G; this plan touches Stage D's `DiagramToolbar` in exactly one contract-scoped sub-step with an explicit contingency if it hasn't landed, and needs nothing from E beyond peaceful coexistence (its new line kinds are additive to the same `ParsedLine` union).

---

## What this stage honestly is — the risk ledger, up front

Read this before writing any code. This is the riskiest stage of the wave and the plan does not pretend otherwise.

1. **OSS mermaid has NO fixed-position support.** Verified absent from v11.16.1 (spec §5): there is no `layout: fixed`, no per-node coordinate input, nothing. Mermaid Chart's "auto-layout off" is proprietary. Everything in this stage is ours: the position format, the transform pipeline, the edge routing. When it breaks, there is no upstream to blame and no upstream to fix it.
2. **We ship mermaid-rendered nodes with OUR edge routing.** In manual mode, every edge we can bind becomes a straight line between two rectangle-border anchor points. Mermaid's curves (basis splines, rounded corners, orthogonal ELK routes) are *gone* for those edges. That is a deliberate aesthetic downgrade traded for positional freedom — the same trade tldraw/excalidraw users accept, but it will look different from auto mode, and users will notice the moment they toggle.
3. **Everything not bindable degrades, visibly.** Edges touching nodes the binding couldn't resolve (opaque lines, id-collision edges per `svgBinding.ts`'s documented undecidables, `handDrawn`-look edges which render as `g` groups rather than `path.flowchart-link`) keep mermaid's original curves — which will visibly *disconnect* from any endpoint node the user drags away. Self-loops (`A --> A`) are never re-routed and disconnect when moved. This is the honest contract: rendering never breaks, geometry fidelity does.
4. **Subgraphs: membership does not drag, clusters do not resize.** Dragging a subgraph child moves that child alone; the cluster rectangle mermaid drew does NOT resize, follow, or re-wrap its children. Drag a child far enough and it sits outside its own cluster's border while still belonging to it in the source. Edges *inside* transformed cluster roots whose ancestry we can't reduce to pure translations are left untouched (see `accumulatedTranslate`), so intra-subgraph edges may disconnect from moved children. Out of scope for this wave; stated in the UI-facing limitations below and NOT hidden.
5. **ELK interplay is measured, not engineered.** The pipeline treats dagre and ELK output identically (measure where the node landed, translate the delta). The spike explicitly tests both. But ELK's orthogonal edge routes look the most different from our straight lines, and `config.elk.*` placement strategies fight hardest against manual intent. Manual mode over ELK is supported but will look the least like its auto rendering.
6. **Positions are absolute; auto-layout drift is real.** A stored position is an absolute plane coordinate (defined precisely in Task G2). Nodes *without* stored positions keep whatever auto layout gives them **this render** — so any edit that re-runs layout moves the unpinned nodes while pinned ones stay put. A half-pinned diagram is a legitimate, slightly janky intermediate state. We accept it; the alternative (snapshot everything on toggle) freezes a layout the user never chose and doubles the diff size.
7. **Parallel edges between the same pair collapse visually.** Two edges `A --> B` declared twice both become the *same* straight segment, stacked, labels overlapping. Mermaid's auto layout spreads them; our straight-line router cannot. Documented limitation.
8. **Border anchoring treats every shape as its bounding box.** Circles, diamonds, hexagons get anchor points on their bbox rectangle, not their true outline — a few pixels of gap or overlap at the arrowhead on non-rect shapes. Acceptable; noted so nobody "fixes" it into a per-shape geometry library mid-implementation.
9. **The lightbox shows auto layout.** `MermaidLightbox` receives the raw svg string (`onExpand(svg)`) before our pipeline touches the DOM, and spec D2 keeps the lightbox as-is this wave. Expanded view of a manual diagram = mermaid's auto geometry. Limitation, stated.

If, mid-implementation, any of these limitations turns out to be *worse* than described (not merely as-bad), stop and report rather than papering over.

---

## Verified DOM contract (vendored mermaid v11.16.1)

Citations are against the vendored source in the **main checkout**: `/Users/joseflagorio/Development/cerebro/docs/examples/mermaid-develop/` (gitignored vendored reference — read it there; never grep it as project code; the worktree does not carry it). All paths below are relative to `packages/mermaid/src/`.

- **Edge path insertion.** `insertEdge` appends the edge as a lone `<path>`: `elem.append('path').attr('d', linePath).attr('id', `${diagramId}-${edge.id}`).attr('class', ' ' + strokeClasses + (edge.classes ? ' ' + edge.classes : '') + …)` — `rendering-util/rendering-elements/edges.js:818-829`. The `flowchart-link` class rides in `edge.classes`, set at parse time in `diagrams/flowchart/flowDb.ts:1259` (`'edge-thickness-normal edge-pattern-solid flowchart-link'`). The path also carries `data-id` = the *bare* edge id (`L_<from>_<to>_<n>`, no diagram prefix) at `edges.js:859`, and `data-points` at `edges.js:860`.
- **Markers are attributes on that same path.** `addEdgeMarkers` (`rendering-util/rendering-elements/edgeMarker.ts:13`) resolves to `svgPath.attr(`marker-${position}`, `url(${url}#${markerId})`)` — `edgeMarker.ts:133` (colored variant) and `edgeMarker.ts:136` (plain). `marker-start`/`marker-end` are plain SVG attributes on the `<path>` element; replacing the `d` attribute does not touch them. (Whether the *rendered arrowhead* survives a `d` swap — orientation included, the markers use `orient="auto"` semantics — is spike question (b): the attribute surviving is a fact, the pixels behaving is what M29.40 verifies.)
- **Edge labels are separate groups.** `insertEdgeLabel` creates an outer `<g class="edgeLabel">` (`edges.js:81`) holding an inner `<g class="label" data-id="<edgeId>">` (`edges.js:84`); the outer group is inserted into the shared `<g class="edgeLabels">` container (`rendering-util/createGraph.ts:36`, populated via `dagre/index.js:407,413`). After layout, `positionEdgeLabel` places the **outer** group with `el.attr('transform', `translate(${x}, ${y + subGraphTitleTotalMargin / 2})`)` — `edges.js:292` (the whole function starts at `edges.js:265`; the label position comes from `utils.calcLabelPosition(path)`, i.e. the path midpoint). So to move a label we look up `g.edgeLabels g.label[data-id="…"]`, take its parent, and set that parent's `transform` — exactly what mermaid itself does.
- **Node groups are positioned by a translate transform.** `positionNode` sets `el.attr('transform', 'translate(' + node.x + ', ' + node.y + ')')` — `rendering-util/rendering-elements/nodes.ts:97`. Node shapes are drawn centered on the group's local origin, so the group's translate IS the node center. Appending a second `translate(dx, dy)` to that attribute composes cleanly.
- **Group nesting.** `createLayoutElementGroups` builds `g.root > (g.clusters, g.edgePaths, g.edgeLabels, g.nodes)` — `createGraph.ts:29-40`. Subgraph recursion creates nested `g.root` groups that may carry their own translate transforms; our `accumulatedTranslate` walk (Task G3) handles pure-translate ancestry and honestly skips anything else.
- **Our own prior contracts** (already shipped, relied on here): node groups bind via `flowchart-<nodeId>-<counter>` with the live render-id prefix stripped (`src/mermaid/flowchart/svgBinding.ts`); bound edge entries carry `line/seg/from/to/arrow/label` plus the element; undecidable id collisions stay unbound.

---

## Repo traps (Stage G edition — read before every task)

- `pnpm test:run`, never `pnpm test` — watch mode never exits.
- **No jest-dom.** This repo does not load `@testing-library/jest-dom`; assert with `toBeTruthy()` / `toBeNull()` / attribute reads, never `toBeInTheDocument()`.
- Zero-warning lint (`pnpm lint` runs `--max-warnings=0`); every `eslint-disable` states its reason in place.
- **Mock renders in vitest.** Unit tests mock `../render` (`vi.mock` + hoisted fixture svg) exactly like `StructuralEditor.test.tsx` already does; real mermaid runs only in e2e.
- **jsdom pointer events carry no coordinates.** `fireEvent.pointerDown(el, { clientX })` reaches the listener without `clientX` (no `PointerEvent` constructor in jsdom — the Stage C ghost-line NaN guards exist for this exact reason). Tests that need drag *coordinates* must dispatch `MouseEvent`s under pointer-event type names — the `firePointer` helper in Task G4 is the sanctioned pattern.
- **jsdom `getBoundingClientRect` returns zeros.** Geometry tests stub it: per-element assignment for the pure-module tests (Task G3), a keyed `Element.prototype` stub for component tests where the code measures before the test can reach the elements (Task G4). `getBBox` is never used by our code — the measurement design below avoids it on purpose.
- **Security hook screens tool calls.** Writing prose or code that *mentions* React's raw-HTML sink (as this plan must — MermaidDiagram uses it) can trip the hook; write such files via a quoted Bash heredoc (`cat > file <<'EOF'`), never through echo escape soup.
- `PORT=5273 pnpm e2e` — the default :5173 reuses whatever dev server is running, including a stale HMR'd one that fails every spec at boot.
- **The mermaid svg subtree is React-free.** All manual-layout DOM work happens imperatively inside the `innerHTML` sink `StructuralEditor` already owns (and, for view mode, inside `MermaidDiagram`'s raw-HTML subtree, which React treats as opaque). Never convert either to React-managed children.
- `docs/examples/` is vendored third-party reference in the **main checkout only** — cite it, read it, never lint/test/grep it as project code.
- Commits: `type(scope): sentence (M29.n)`, one phase per commit. Never `--no-verify`.

---

### Task G1: Feasibility spike — go / no-go for free-drag (M29.40)

**Time box: half a day (≈4 focused hours). When the box expires, write up whatever you have and stop.**

**Files:**
- Create *temporarily*: `e2e/_spike-manual-layout.spec.ts` — **THROWAWAY. Deleted before the commit. Nothing from this task ships except the NOTES section of this plan file.**
- Modify: `docs/superpowers/plans/2026-08-09-cerebro-m29g-manual-layout.md` (this file — fill in the NOTES template at the bottom)

The spike answers three questions with evidence, on the real app against real mermaid:

- **(a) Post-render re-layout works.** Can we translate mermaid node groups after render and replace edge `d` attributes with straight lines — arrowheads present *and correctly oriented along the new line*, labels movable to the midpoint, no leftover fragments of the old curve, no clipping at the svg's viewBox edge when a node is dragged outward — on BOTH a dagre-rendered and an ELK-rendered flowchart?
- **(b) Marker refs survive `d` replacement.** After setting a new `d`, are `marker-start`/`marker-end` attribute values unchanged AND do the arrowheads still *render* (attribute surviving is guaranteed by the DOM contract; pixels are what we're checking — a broken `url(#…)` re-resolution or a non-`orient=auto` marker would show here)?
- **(c) Drag can feel right.** With a 50-node diagram, can we update one node's transform plus straight-line re-routes for its incident edges every frame at 60fps (avg frame ≤ 16.7ms, p95 ≤ 33ms), doing transform/`d`-only DOM writes with zero React involvement?

- [x] **Step 1: Write the throwaway spike spec**

Create `e2e/_spike-manual-layout.spec.ts`. This is scaffolding, not a test — assertions are loose on purpose; the deliverable is the console output and the screenshots you eyeball.

```ts
import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
  }
}

/**
 * M29.40 SPIKE — THROWAWAY. Answers spec D7's three feasibility questions.
 * Delete this file after transcribing findings into the Stage G plan's NOTES.
 */

/** Runs inside the page: translate a node group, re-route its edges straight. */
const SPIKE_SNIPPET = `(() => {
  const svg = document.querySelector('[data-testid="structural-host"] svg')
    ?? document.querySelector('[data-testid="mermaid-diagram"] svg');
  if (!svg) return { error: 'no svg' };
  const nodes = [...svg.querySelectorAll('g.node[id*="flowchart-"]')];
  const paths = [...svg.querySelectorAll('path.flowchart-link')];
  if (nodes.length < 2 || paths.length === 0) return { error: 'too sparse' };

  const svgRect = svg.getBoundingClientRect();
  const vb = svg.getAttribute('viewBox').split(/\\s+/).map(Number);
  const scale = svgRect.width / vb[2];
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left + r.width / 2 - svgRect.left) / scale + vb[0],
      y: (r.top + r.height / 2 - svgRect.top) / scale + vb[1],
      hw: r.width / 2 / scale,
      hh: r.height / 2 / scale,
    };
  };

  // (a) translate the first node 120,80 away from home.
  const moved = nodes[0];
  const before = center(moved);
  moved.setAttribute('transform', (moved.getAttribute('transform') ?? '') + ' translate(120, 80)');
  const after = center(moved);

  // (b) capture markers, replace every edge d with a straight border-to-border
  // line between measured node centers, re-check markers.
  const boxes = new Map(nodes.map((el) => {
    const m = el.id.match(/flowchart-(.+)-\\d+$/);
    return [m ? m[1] : el.id, center(el)];
  }));
  const border = (b, t) => {
    const dx = t.x - b.x, dy = t.y - b.y;
    if (dx === 0 && dy === 0) return { x: b.x, y: b.y };
    const s = Math.min(dx !== 0 ? b.hw / Math.abs(dx) : Infinity,
                       dy !== 0 ? b.hh / Math.abs(dy) : Infinity);
    return { x: b.x + dx * s, y: b.y + dy * s };
  };
  const markerReport = [];
  for (const p of paths) {
    const id = p.getAttribute('data-id') ?? p.id;
    const m = id.match(/L_(.+?)_(.+?)_\\d+$/);
    if (!m) continue;
    const from = boxes.get(m[1]);
    const to = boxes.get(m[2]);
    if (!from || !to) continue;
    const pre = { s: p.getAttribute('marker-start'), e: p.getAttribute('marker-end') };
    const a = border(from, to), b2 = border(to, from);
    p.setAttribute('d', 'M' + a.x + ',' + a.y + 'L' + b2.x + ',' + b2.y);
    const post = { s: p.getAttribute('marker-start'), e: p.getAttribute('marker-end') };
    markerReport.push({ id, survived: pre.s === post.s && pre.e === post.e });
    // move the label to the midpoint, mermaid-style (edges.js:292)
    const label = svg.querySelector('g.edgeLabels g.label[data-id="' + id + '"]');
    if (label && label.parentElement) {
      label.parentElement.setAttribute(
        'transform', 'translate(' + (a.x + b2.x) / 2 + ', ' + (a.y + b2.y) / 2 + ')');
    }
  }
  return { movedDelta: { dx: after.x - before.x, dy: after.y - before.y }, markerReport };
})()`;

async function bootAndOpen(page, docName: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(docName);
  await page.getByTestId('quick-open-result').filter({ hasText: docName }).first().click();
}

test('spike a+b: dagre — translate, re-route, markers', async ({ page }) => {
  test.setTimeout(90_000);
  await bootAndOpen(page, 'Systems map');
  await page.getByTestId('mermaid-block').first().getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('structural-host').locator('svg').waitFor({ timeout: 20_000 });
  const report = await page.evaluate(SPIKE_SNIPPET);
  console.log('DAGRE REPORT', JSON.stringify(report, null, 2));
  await page.screenshot({ path: 'spike-dagre.png', fullPage: true });
  expect(report).not.toHaveProperty('error');
});

test('spike a+b: elk — same routine on the fourth fence', async ({ page }) => {
  test.setTimeout(90_000);
  await bootAndOpen(page, 'Systems map');
  // Fence 4 is the ELK-layout flowchart (see e2e/diagrams.spec.ts test 1).
  await page.getByTestId('mermaid-block').nth(3).getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('structural-host').locator('svg').waitFor({ timeout: 30_000 });
  const report = await page.evaluate(SPIKE_SNIPPET);
  console.log('ELK REPORT', JSON.stringify(report, null, 2));
  await page.screenshot({ path: 'spike-elk.png', fullPage: true });
  expect(report).not.toHaveProperty('error');
});

test('spike c: 50-node drag at 60fps', async ({ page }) => {
  test.setTimeout(120_000);
  await bootAndOpen(page, 'Systems map');
  await page.getByTestId('mermaid-block').first().getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('structural-host').locator('svg').waitFor({ timeout: 20_000 });
  // Swap in a generated 50-node / 60-edge flowchart through the code mode.
  const big = ['flowchart TD'];
  for (let i = 0; i < 50; i += 1) big.push(`  n${i}[Step ${i}]`);
  for (let i = 0; i < 49; i += 1) big.push(`  n${i} --> n${i + 1}`);
  for (let i = 0; i < 11; i += 1) big.push(`  n${i} --> n${(i * 7 + 13) % 50}`);
  await page.getByRole('button', { name: 'Show code' }).click();
  await page.getByLabel('Mermaid source').fill(big.join('\n'));
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await page.getByTestId('structural-host').locator('g.node').nth(49).waitFor({ timeout: 30_000 });

  const frames = await page.evaluate(`new Promise((resolve) => {
    const svg = document.querySelector('[data-testid="structural-host"] svg');
    const node = svg.querySelectorAll('g.node')[25];
    const base = node.getAttribute('transform') ?? '';
    const incident = [...svg.querySelectorAll('path.flowchart-link')].slice(0, 3);
    const times = [];
    let last = performance.now();
    let i = 0;
    const tick = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      const d = i * 2;
      node.setAttribute('transform', base + ' translate(' + d + ', ' + (d / 2) + ')');
      for (const p of incident) {
        p.setAttribute('d', 'M' + d + ',' + d + 'L' + (d + 200) + ',' + (d + 100));
      }
      i += 1;
      if (i < 180) requestAnimationFrame(tick);
      else resolve(times.slice(1));
    };
    requestAnimationFrame(tick);
  })`);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const p95 = [...frames].sort((a, b) => a - b)[Math.floor(frames.length * 0.95)];
  console.log(`PERF avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms over ${frames.length} frames`);
  expect(avg).toBeLessThan(50); // loose — the real judgment is written into NOTES
});
```

- [x] **Step 2: Run the spike**

```bash
PORT=5273 pnpm e2e -- _spike-manual-layout.spec.ts
```

Open `spike-dagre.png` and `spike-elk.png` and *look*: are arrowheads sitting at the ends of the straight lines, pointed along them? Is the moved node clean (no ghost of its old position, no clipped half-node at the viewBox edge)? Are labels at midpoints? Record the console reports.

- [x] **Step 3: Write the findings into this plan's NOTES section and judge the gate**

**Exit criteria — all three must be YES to proceed to Task G2:**

1. **(a) YES** iff on *both* screenshots: the translated node renders whole (clipping at the svg border is acceptable ONLY if noted — the shipped pipeline inherits it), every re-routed edge is a clean straight segment with an arrowhead at its end oriented along the segment, labels sit at midpoints, and no fragment of any pre-replacement path remains.
2. **(b) YES** iff every entry in both `markerReport`s has `survived: true` AND the screenshots show arrowheads actually rendering after replacement.
3. **(c) YES** iff `avg ≤ 16.7ms` and `p95 ≤ 33ms` on the dev machine.

**If all YES:** fill in NOTES, delete the spike file, commit, continue to Task G2.

**If any NO — the fallback branch, and a full stop:**

The fallback scope is **per-node OFFSET nudging**: keep M29.41's model work unchanged (same comment format, same ops — the file format is deliberately identical so no migration is ever needed), but M29.42's pipeline only translates node groups and **never touches edge paths**. Mermaid's curves keep ending where the node *used to* be, so edges visually detach as offsets grow; under roughly ±40px the slack reads as acceptable looseness. Why that is still worth shipping: it covers the actual majority use cases observed in mermaid.ai sessions — nudging one node out of a label collision, aligning a row mermaid staggered, separating two nodes dagre packed too tight — all small-offset moves where edge slack is invisible. Full free-drag would remain a future stage once the failing criterion has an answer.

**The implementer does NOT choose this branch.** Commit the NOTES (including which criterion failed and the evidence), delete the spike file, and report to the coordinator: *"M29.40 gate failed on (x); options are fallback scope as written, defer Stage G, or a redesign; awaiting scope decision."* Then stop.

- [x] **Step 4: Delete the spike, commit the findings**

```bash
rm e2e/_spike-manual-layout.spec.ts spike-dagre.png spike-elk.png
git status   # must show ONLY this plan file modified
git add docs/superpowers/plans/2026-08-09-cerebro-m29g-manual-layout.md
git commit -m "docs(plans): M29 Stage G spike findings — manual layout go/no-go (M29.40)"
```

---

### Task G2: The model owns its positions — `pos-comment` and `layout-mode` kinds (M29.41)

**Files:**
- Modify: `src/mermaid/flowchart/model.ts`
- Modify: `src/mermaid/flowchart/ops.ts`
- Modify: `src/mermaid/flowchart/model.test.ts`
- Modify: `src/mermaid/flowchart/ops.test.ts`

**The position semantics, defined precisely (everything downstream leans on this):**

> A stored position is the **absolute point, in the rendered SVG's user-coordinate system** (the space the root `viewBox` describes — the same units mermaid lays out in; "plane coordinates" hereafter), **where the center of the node's bounding box must sit after our manual transform is applied**. It is *not* an offset from auto layout: auto layout changes with every edit and engine flip, so offsets would drift. Each render, the pipeline measures where mermaid put the node (its auto center, in plane units) and translates the group by `stored − auto`. A node absent from the positions line keeps its auto position for that render. Coordinates are emitted as integers (rounded at op time); parse accepts decimals.

**The grammar:**

```
%% cerebro:pos <id> <x>,<y> [<id> <x>,<y> …]     one line holds ALL positions
%% cerebro:layout manual                          presence = manual mode on
```

Both are ordinary mermaid comments (`%%` to end of line — and NOT the `%%{…}%%` directive form, so mermaid ignores them unconditionally). Ids match the model's `ID_PATTERN` (`[A-Za-z0-9_.-]+` — no whitespace, no commas), so space-separated tokens are unambiguous. Any `%%` line that *starts* like a cerebro marker but doesn't fully parse goes **opaque** — never guessed at, preserved byte-for-byte, invisible to the ops. Every other `%%` line stays opaque exactly as today.

- [ ] **Step 1: Write the failing tests**

Append to `src/mermaid/flowchart/model.test.ts` (extend the existing imports from `./model` with `isManualLayout, storedPositions`):

```ts
describe('cerebro pos/layout comments (M29.41)', () => {
  const MANUAL = [
    'flowchart TD',
    '  %% cerebro:layout manual',
    '  %% cerebro:pos A 120,40 B 300,200',
    '  A[Start] --> B{Choice}',
    '  %% an ordinary comment stays opaque',
  ].join('\n');

  it('parses the layout marker and the positions line as understood kinds', () => {
    const model = parseFlowchart(MANUAL)!;
    expect(model.lines[1].parsed).toEqual({ kind: 'layout-mode', manual: true });
    const pos = model.lines[2].parsed;
    expect(pos.kind).toBe('pos-comment');
    if (pos.kind === 'pos-comment') {
      expect(pos.positions.get('A')).toEqual({ x: 120, y: 40 });
      expect(pos.positions.get('B')).toEqual({ x: 300, y: 200 });
    }
    expect(model.lines[4].parsed.kind).toBe('opaque');
  });

  it('exposes isManualLayout and storedPositions', () => {
    const model = parseFlowchart(MANUAL)!;
    expect(isManualLayout(model)).toBe(true);
    expect(storedPositions(model).get('B')).toEqual({ x: 300, y: 200 });
    const auto = parseFlowchart(SIMPLE)!;
    expect(isManualLayout(auto)).toBe(false);
    expect(storedPositions(auto).size).toBe(0);
  });

  it('malformed cerebro lines go opaque — never guessed at', () => {
    for (const bad of [
      '%% cerebro:pos A 12', // missing y
      '%% cerebro:pos A twelve,40', // non-numeric
      '%% cerebro:pos A 12,40 B', // odd token count
      '%% cerebro:layout automatic', // unknown mode
    ]) {
      const m = parseFlowchart(`flowchart TD\n  ${bad}\n  A --> B`)!;
      expect(m.lines[1].parsed.kind).toBe('opaque');
    }
  });

  it('round-trips untouched cerebro lines byte-identically — weird spacing included', () => {
    const quirky = 'flowchart TD\n  %%  cerebro:pos  B 10,20   A 5,6\n  A --> B';
    expect(serialize(parseFlowchart(quirky)!)).toBe(quirky);
  });
});
```

Append to `src/mermaid/flowchart/ops.test.ts` (extend the ops import with `clearPositions, setManualLayout, setNodePosition`):

```ts
describe('setNodePosition / clearPositions / setManualLayout (M29.41)', () => {
  it('creates the positions line right after the header on first use', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B')!;
    const out = serialize(setNodePosition(m, 'B', { x: 300.4, y: 199.6 }));
    expect(out).toBe('flowchart TD\n  %% cerebro:pos B 300,200\n  A[Start] --> B');
  });

  it('patches the one existing line — sorted by id, rounded to integers', () => {
    const src = 'flowchart TD\n  %% cerebro:pos B 10,20\n  A --> B';
    const out = serialize(setNodePosition(parseFlowchart(src)!, 'A', { x: 5.5, y: 6.4 }));
    expect(out).toBe('flowchart TD\n  %% cerebro:pos A 6,6 B 10,20\n  A --> B');
  });

  it('keeps the cerebro block contiguous: pos lands after a layout marker on the header', () => {
    const src = 'flowchart TD\n  %% cerebro:layout manual\n  A --> B';
    const out = serialize(setNodePosition(parseFlowchart(src)!, 'A', { x: 1, y: 2 }));
    expect(out).toBe('flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 1,2\n  A --> B');
  });

  it('setManualLayout writes and removes the marker; positions survive off', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const on = serialize(setManualLayout(m, true));
    expect(on).toBe('flowchart TD\n  %% cerebro:layout manual\n  A --> B');
    const withPos = serialize(setNodePosition(parseFlowchart(on)!, 'A', { x: 9, y: 9 }));
    const off = serialize(setManualLayout(parseFlowchart(withPos)!, false));
    expect(off).toBe('flowchart TD\n  %% cerebro:pos A 9,9\n  A --> B');
    expect(serialize(setManualLayout(parseFlowchart(off)!, false))).toBe(off); // idempotent
  });

  it('clearPositions removes the positions line and nothing else', () => {
    const src = 'flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 9,9\n  A --> B';
    expect(serialize(clearPositions(parseFlowchart(src)!))).toBe(
      'flowchart TD\n  %% cerebro:layout manual\n  A --> B',
    );
  });

  it('deleteNode drops the node from the positions line too — no zombie coords', () => {
    const src = 'flowchart TD\n  %% cerebro:pos A 9,9 B 10,10\n  A[Start] --> B[End]';
    const out = serialize(deleteNode(parseFlowchart(src)!, 'B'));
    expect(out).toContain('%% cerebro:pos A 9,9');
    expect(out).not.toContain('B 10,10');
    const single = 'flowchart TD\n  %% cerebro:pos B 10,10\n  A --> B';
    const gone = serialize(deleteNode(parseFlowchart(single)!, 'B'));
    expect(gone).not.toContain('cerebro:pos'); // an emptied line is removed entirely
  });

  it('an untouched positions line stays byte-identical through unrelated ops', () => {
    const src = 'flowchart TD\n  %%  cerebro:pos  B 10,20   A 5,6\n  A[Old] --> B';
    const out = serialize(renameNode(parseFlowchart(src)!, 'A', 'New'));
    expect(out).toContain('%%  cerebro:pos  B 10,20   A 5,6');
  });
});
```

Rationale for the zombie-coords rule: node ids are reusable — delete `B`, later add a node the id generator names `B` (or the user types one), and a leftover `B 10,10` would silently teleport the newcomer. `deleteNode` already erases every other trace of the node; positions are one more trace.

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/flowchart/model.test.ts src/mermaid/flowchart/ops.test.ts`
Expected: FAIL — `isManualLayout` / `setNodePosition` etc. not exported.

- [ ] **Step 3: Implement the model side (`model.ts`)**

Extend `ParsedLine` (two new members; Stage E adds its own members to the same union independently — additive, no conflict):

```ts
export type ParsedLine =
  | { kind: 'header'; keyword: 'flowchart' | 'graph'; direction: Direction }
  | { kind: 'node'; node: NodeRef }
  | { kind: 'edges'; segments: EdgeSegment[] }
  | { kind: 'subgraph-start'; title: string }
  | { kind: 'subgraph-end' }
  | { kind: 'pos-comment'; positions: Map<string, { x: number; y: number }> }
  | { kind: 'layout-mode'; manual: true }
  | { kind: 'opaque' };
```

Add the cerebro-comment parser (near `parseLine`) and reroute the `%%` branch. Replace the current first guard of `parseLine`'s body:

```ts
  const trimmed = rawLine.trim();
  if (trimmed === '') return { kind: 'opaque' };
  if (trimmed.startsWith('%%')) return parseCerebroComment(trimmed) ?? { kind: 'opaque' };
```

with the new helper alongside:

```ts
const POS_LINE = /^%%\s*cerebro:pos\s+(\S.*)$/;
const LAYOUT_LINE = /^%%\s*cerebro:layout\s+manual\s*$/;
const POS_ID = /^[A-Za-z0-9_.-]+$/;
const POS_COORD = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

/**
 * Our two marker comments (M29.41). Anything that isn't a byte-perfect match
 * for the grammar returns null and the caller keeps the line opaque — a
 * half-written `%% cerebro:pos A 12` must never be "repaired" into data.
 * Both are plain `%%` comments (not `%%{ }%%` directives), so mermaid skips
 * them unconditionally.
 */
function parseCerebroComment(trimmed: string): ParsedLine | null {
  if (LAYOUT_LINE.test(trimmed)) return { kind: 'layout-mode', manual: true };
  const m = trimmed.match(POS_LINE);
  if (m === null) return null;
  const tokens = m[1].trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length % 2 !== 0) return null;
  const positions = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < tokens.length; i += 2) {
    const id = tokens[i];
    const coord = tokens[i + 1].match(POS_COORD);
    if (!POS_ID.test(id) || coord === null) return null;
    positions.set(id, { x: Number(coord[1]), y: Number(coord[2]) });
  }
  return { kind: 'pos-comment', positions };
}
```

`emitLine`'s switch is exhaustive over `ParsedLine` — the compiler forces the two new cases:

```ts
    case 'pos-comment': {
      // Sorted by id for a deterministic emit: the same positions always
      // produce the same bytes regardless of insertion order.
      const entries = [...p.positions.entries()].sort(([a], [b]) => a.localeCompare(b));
      const body = entries
        .map(([id, pt]) => `${id} ${Math.round(pt.x)},${Math.round(pt.y)}`)
        .join(' ');
      return `${indent}%% cerebro:pos ${body}`;
    }
    case 'layout-mode':
      return `${indent}%% cerebro:layout manual`;
```

Read helpers at the bottom of `model.ts`:

```ts
/** True when the diagram carries the `%% cerebro:layout manual` marker. */
export function isManualLayout(model: FlowchartModel): boolean {
  return model.lines.some((l) => l.parsed.kind === 'layout-mode');
}

/**
 * Stored node positions — ABSOLUTE plane coordinates of node centers (see the
 * Stage G plan for the precise definition). The first pos-comment line wins;
 * later duplicates are preserved as data but never read or written.
 */
export function storedPositions(model: FlowchartModel): Map<string, { x: number; y: number }> {
  for (const line of model.lines) {
    if (line.parsed.kind === 'pos-comment') return new Map(line.parsed.positions);
  }
  return new Map();
}
```

(`structuredClone` in `ops.ts` clones `Map`s natively — the new kind rides through `clone()` untouched.)

- [ ] **Step 4: Implement the ops side (`ops.ts`)**

```ts
/**
 * Stores a node's position (M29.41): absolute plane coordinates of the node
 * center — see storedPositions in model.ts. One pos-comment line holds every
 * position; it is patched in place (first line wins) or created right after
 * the header — after the layout-mode marker when that sits on the header, so
 * the cerebro block stays contiguous and diffs stay one-line.
 */
export function setNodePosition(
  model: FlowchartModel,
  id: string,
  pos: { x: number; y: number },
): FlowchartModel {
  const next = clone(model);
  const rounded = { x: Math.round(pos.x), y: Math.round(pos.y) };
  for (const line of next.lines) {
    if (line.parsed.kind === 'pos-comment') {
      line.parsed.positions.set(id, rounded);
      line.dirty = true;
      return next;
    }
  }
  let at = headerIndex(next) + 1;
  if (next.lines[at]?.parsed.kind === 'layout-mode') at += 1;
  next.lines.splice(at, 0, {
    raw: '  ',
    parsed: { kind: 'pos-comment', positions: new Map([[id, rounded]]) },
    dirty: true,
  });
  return next;
}

/** Removes every stored position (the pos-comment lines themselves). */
export function clearPositions(model: FlowchartModel): FlowchartModel {
  const next = clone(model);
  for (let i = next.lines.length - 1; i >= 0; i -= 1) {
    if (next.lines[i].parsed.kind === 'pos-comment') next.lines.splice(i, 1);
  }
  return next;
}

/**
 * Toggles the manual-layout marker. OFF removes only the marker — stored
 * positions are deliberately RETAINED so toggling back on restores the hand
 * layout (spec D7).
 */
export function setManualLayout(model: FlowchartModel, on: boolean): FlowchartModel {
  const next = clone(model);
  if (on) {
    if (next.lines.some((l) => l.parsed.kind === 'layout-mode')) return next;
    next.lines.splice(headerIndex(next) + 1, 0, {
      raw: '  ',
      parsed: { kind: 'layout-mode', manual: true },
      dirty: true,
    });
    return next;
  }
  for (let i = next.lines.length - 1; i >= 0; i -= 1) {
    if (next.lines[i].parsed.kind === 'layout-mode') next.lines.splice(i, 1);
  }
  return next;
}
```

And in `deleteNode`, extend the backwards walk with a third branch (after the `edges` branch):

```ts
    } else if (parsed.kind === 'pos-comment' && parsed.positions.has(id)) {
      // A deleted node's coordinates must not lie in wait for a future node
      // that happens to reuse the id.
      parsed.positions.delete(id);
      if (parsed.positions.size === 0) next.lines.splice(i, 1);
      else next.lines[i].dirty = true;
    }
```

Note what is *not* here: `renameNode` and `setNodeShape` never touch positions — ids are immutable (the standing invariant), so a rename keeps its hand position for free.

- [ ] **Step 5: Run, lint, commit**

```bash
pnpm test:run src/mermaid/flowchart/ && pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/model.ts src/mermaid/flowchart/ops.ts \
        src/mermaid/flowchart/model.test.ts src/mermaid/flowchart/ops.test.ts
git commit -m "feat(mermaid): the model owns node positions — cerebro:pos and layout-manual comments (M29.41)"
```

---

### Task G3: The manual render pipeline — transforms, straight edges, honest degradation (M29.42)

**Files:**
- Create: `src/mermaid/flowchart/manualLayout.ts`
- Create: `src/mermaid/flowchart/manualLayout.test.ts`
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx` (run the pipeline after bind)
- Modify: `src/mermaid/MermaidDiagram.tsx` (read-only pipeline for view mode)
- Modify: `src/mermaid/MermaidDiagram.test.tsx` (one view-mode test)

**Measurement design (the part jsdom forces us to get right up front):** the pipeline never calls `getBBox` or `getScreenCTM` (jsdom has neither). Every measurement is `getBoundingClientRect` plus the svg's `viewBox` *attribute* (a string, parseable anywhere): `scale = svgClientWidth / viewBoxWidth`, and a client point maps to plane coordinates as `(client − svgClientOrigin) / scale + viewBoxOrigin`. Because client rects include every ancestor CSS transform, **CanvasViewport zoom (Stage D) is absorbed automatically** — no `useCanvasTransform` read is needed for measurement or drag math. In tests, `getBoundingClientRect` is stubbed per element (this task) or via a keyed prototype stub (Task G4); an unstubbed zero-size svg makes `beginManualLayout` return `null`, which is also the honest production behavior inside a `display:none` host.

**Coordinate honesty for writes:** node deltas and edge/label coordinates are applied in the element's *parent* coordinate system. Mermaid nests content in `g.root` groups that carry only `translate(…)` transforms (contract section above). `accumulatedTranslate` walks the ancestry and sums pure translates; any ancestor with a non-translate transform makes the walk return `null` and that element is **left untouched** — degradation, never garbage.

- [ ] **Step 1: Write the failing tests**

Create `src/mermaid/flowchart/manualLayout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseFlowchart } from './model';
import { bindFlowchartSvg } from './svgBinding';
import {
  accumulatedTranslate,
  applyManualLayout,
  beginManualLayout,
  clientToPlane,
  moveNode,
  rectBorderPoint,
} from './manualLayout';

const SVG = [
  '<svg viewBox="0 0 200 100">',
  '<g class="root">',
  '<g class="edgePaths">',
  '<path class="flowchart-link" id="L_A_B_0" data-id="L_A_B_0"',
  ' d="M30,25C60,30 90,50 120,65" marker-end="url(#m-end)" marker-start="url(#m-start)"/>',
  '<path class="flowchart-link" id="L_B_C_0" data-id="L_B_C_0" d="M1,1L2,2"/>',
  '</g>',
  '<g class="edgeLabels">',
  '<g class="edgeLabel"><g class="label" data-id="L_A_B_0"><text>go</text></g></g>',
  '</g>',
  '<g class="nodes">',
  '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
  '<g class="node" id="flowchart-B-1" transform="translate(130, 70)"><rect/></g>',
  '</g>',
  '</g>',
  '</svg>',
].join('');

// C exists in the model but not in the svg: its edge binds by id, its node
// does not — the exact "bound edge, unbound endpoint" degradation case.
const CODE = 'flowchart TD\n  A[Start] --> B[End]\n  B --> C[Ghost]';

function stubRect(
  el: Element,
  r: { left: number; top: number; width: number; height: number },
): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** Fixture at scale 1: svg client box 200x100 over viewBox 0 0 200 100. */
function setup() {
  const host = document.createElement('div');
  host.innerHTML = SVG;
  const svg = host.querySelector('svg')!;
  stubRect(svg, { left: 0, top: 0, width: 200, height: 100 });
  stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
  stubRect(host.querySelector('#flowchart-B-1')!, { left: 120, top: 60, width: 20, height: 20 });
  const model = parseFlowchart(CODE)!;
  const binding = bindFlowchartSvg(host, model);
  const session = beginManualLayout(host, binding)!;
  return { host, svg, binding, session };
}

describe('rectBorderPoint', () => {
  it('projects the center-to-target ray onto the box border', () => {
    const box = { cx: 0, cy: 0, halfW: 10, halfH: 5 };
    expect(rectBorderPoint(box, { x: 20, y: 0 })).toEqual({ x: 10, y: 0 });
    expect(rectBorderPoint(box, { x: 0, y: 20 })).toEqual({ x: 0, y: 5 });
    expect(rectBorderPoint(box, { x: 20, y: 10 })).toEqual({ x: 10, y: 5 });
    expect(rectBorderPoint(box, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('accumulatedTranslate', () => {
  it('sums pure translates and refuses anything else', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<svg><g transform="translate(10, 5)"><g transform="translate(2,3)"><g id="x"/></g></g></svg>';
    const svg = host.querySelector('svg')!;
    expect(accumulatedTranslate(host.querySelector('#x')!, svg)).toEqual({ x: 12, y: 8 });
    host.innerHTML = '<svg><g transform="translate(7)"><g id="y"/></g></svg>';
    expect(accumulatedTranslate(host.querySelector('#y')!, host.querySelector('svg')!)).toEqual({
      x: 7,
      y: 0,
    });
    host.innerHTML = '<svg><g transform="scale(2)"><g id="z"/></g></svg>';
    expect(accumulatedTranslate(host.querySelector('#z')!, host.querySelector('svg')!)).toBeNull();
  });
});

describe('beginManualLayout', () => {
  it('measures node boxes in plane units and captures base transforms', () => {
    const { session } = setup();
    expect(session.boxes.get('A')).toEqual({ cx: 30, cy: 20, halfW: 10, halfH: 10 });
    expect(session.auto.get('B')).toEqual({ x: 130, y: 70 });
    expect(session.base.get('A')).toBe('translate(30, 20)');
  });

  it('returns null when the svg has no measurable size (jsdom default, display:none)', () => {
    const host = document.createElement('div');
    host.innerHTML = SVG; // rects unstubbed → zeros
    const model = parseFlowchart(CODE)!;
    expect(beginManualLayout(host, bindFlowchartSvg(host, model))).toBeNull();
  });
});

describe('clientToPlane', () => {
  it('maps through origin and scale', () => {
    const host = document.createElement('div');
    host.innerHTML = SVG;
    const svg = host.querySelector('svg')!;
    stubRect(svg, { left: 40, top: 10, width: 400, height: 200 }); // scale 2
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 40, top: 10, width: 40, height: 40 });
    stubRect(host.querySelector('#flowchart-B-1')!, { left: 240, top: 130, width: 40, height: 40 });
    const model = parseFlowchart(CODE)!;
    const session = beginManualLayout(host, bindFlowchartSvg(host, model))!;
    expect(clientToPlane(session, { x: 140, y: 110 })).toEqual({ x: 50, y: 50 });
  });
});

describe('applyManualLayout', () => {
  it('translates stored nodes, straightens bound edges, moves labels, preserves markers', () => {
    const { host, binding, session } = setup();
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));

    const a = host.querySelector('#flowchart-A-0')!;
    expect(a.getAttribute('transform')).toBe('translate(30, 20) translate(20, 0)');
    // B has no stored position: untouched.
    expect(host.querySelector('#flowchart-B-1')!.getAttribute('transform')).toBe(
      'translate(130, 70)',
    );

    const edge = host.querySelector('#L_A_B_0')!;
    // A now at (50,20) hw10 hh10; B at (130,70): dx=80 dy=50 → s=0.125 →
    // anchors (60, 26.25) and (120, 63.75).
    expect(edge.getAttribute('d')).toBe('M60,26.25L120,63.75');
    expect(edge.getAttribute('marker-end')).toBe('url(#m-end)');
    expect(edge.getAttribute('marker-start')).toBe('url(#m-start)');

    const labelOuter = host.querySelector('g.label[data-id="L_A_B_0"]')!.parentElement!;
    expect(labelOuter.getAttribute('transform')).toBe('translate(90, 45)');

    // B→C: C has no svg group, so no box — the path is left untouched.
    expect(host.querySelector('#L_B_C_0')!.getAttribute('d')).toBe('M1,1L2,2');
  });

  it('re-applying is idempotent — base transforms are remembered, not compounded', () => {
    const { host, binding, session } = setup();
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20) translate(20, 0)',
    );
  });
});

describe('moveNode', () => {
  it('moves one node and re-routes only its incident bound edges', () => {
    const { host, binding, session } = setup();
    moveNode(session, binding, 'A', { x: 50, y: 20 });
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20) translate(20, 0)',
    );
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M60,26.25L120,63.75');
    expect(host.querySelector('#L_B_C_0')!.getAttribute('d')).toBe('M1,1L2,2');
  });

  it('never re-routes a self-loop', () => {
    const host = document.createElement('div');
    host.innerHTML = [
      '<svg viewBox="0 0 200 100">',
      '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
      '<path class="flowchart-link" id="L_A_A_0" data-id="L_A_A_0" d="M9,9C1,1 2,2 9,9"/>',
      '</svg>',
    ].join('');
    stubRect(host.querySelector('svg')!, { left: 0, top: 0, width: 200, height: 100 });
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
    const model = parseFlowchart('flowchart TD\n  A[Loop] --> A')!;
    const binding = bindFlowchartSvg(host, model);
    const session = beginManualLayout(host, binding)!;
    moveNode(session, binding, 'A', { x: 90, y: 50 });
    expect(host.querySelector('#L_A_A_0')!.getAttribute('d')).toBe('M9,9C1,1 2,2 9,9');
  });
});
```

- [ ] **Step 2: Run to make sure it fails**

Run: `pnpm test:run src/mermaid/flowchart/manualLayout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mermaid/flowchart/manualLayout.ts`**

```ts
import type { FlowchartModel } from './model';
import { isManualLayout, parseFlowchart, storedPositions } from './model';
import type { FlowchartSvgBinding } from './svgBinding';
import { bindFlowchartSvg } from './svgBinding';

/**
 * Manual layout (M29.42) — the React-free geometry layer that runs AFTER
 * mermaid renders and the binding resolves.
 *
 * Positions are ABSOLUTE plane coordinates of node centers ("plane" = the
 * root svg's user-coordinate system, the space its viewBox describes). Each
 * application measures where mermaid put a node (its auto center) and
 * translates the group by stored − auto, appending a second translate after
 * mermaid's own (nodes.ts:97 sets the first). Bound edges are re-routed as
 * straight segments between the two nodes' bbox-border anchor points;
 * marker-start/marker-end are attributes on the same <path> (edgeMarker.ts:
 * 133/136) so replacing `d` leaves the arrowheads alone — spike-verified in
 * M29.40. Labels move to the segment midpoint by translating the outer
 * g.edgeLabel, mirroring mermaid's positionEdgeLabel (edges.js:292).
 *
 * Measurement is getBoundingClientRect + the viewBox ATTRIBUTE only — no
 * getBBox, no getScreenCTM — so jsdom can drive every function with stubbed
 * rects, and ancestor CSS transforms (CanvasViewport zoom) are absorbed for
 * free. Writes happen in parent coordinates: ancestors are required to carry
 * pure translate() transforms (mermaid's g.root nesting does); anything else
 * makes us leave that element untouched. Degradation is always "mermaid's
 * original geometry stays", never garbage.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ManualLayoutSession {
  svg: SVGSVGElement;
  /** Client pixels per plane unit (includes any ancestor CSS zoom). */
  scale: number;
  /** Client position of the plane's viewBox origin. */
  origin: Pt;
  vb: ViewBox;
  /** Live node boxes in plane units — mutated as nodes move. */
  boxes: Map<string, Box>;
  /** Mermaid's auto centers, measured once on the pristine render. */
  auto: Map<string, Pt>;
  /** Each group's transform attribute exactly as mermaid rendered it. */
  base: Map<string, string>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function viewBoxOf(svg: SVGSVGElement): ViewBox | null {
  // The attribute, not svg.viewBox.baseVal: jsdom implements only the former.
  const raw = svg.getAttribute('viewBox');
  if (raw === null) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/** Border point of `box` on the ray from its center toward `target`. */
export function rectBorderPoint(box: Box, target: Pt): Pt {
  const dx = target.x - box.cx;
  const dy = target.y - box.cy;
  if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy };
  // Scale the direction vector until its larger normalized component reaches
  // the box border: s = min over axes of halfExtent / |component|.
  const sx = dx !== 0 ? box.halfW / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? box.halfH / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: box.cx + dx * s, y: box.cy + dy * s };
}

const TRANSLATE_ONLY = /^translate\(\s*(-?\d+(?:\.\d+)?)(?:[\s,]+(-?\d+(?:\.\d+)?))?\s*\)$/;

/**
 * Sum of translate(x[,y]) transforms on ancestors strictly between `el` and
 * the svg root. Null when any ancestor carries anything other than a single
 * pure translate — the caller must then leave the element untouched.
 */
export function accumulatedTranslate(el: Element, svg: SVGSVGElement): Pt | null {
  let x = 0;
  let y = 0;
  for (
    let cur = el.parentElement;
    cur !== null && cur !== (svg as Element);
    cur = cur.parentElement
  ) {
    const t = cur.getAttribute('transform');
    if (t === null || t.trim() === '') continue;
    const m = t.trim().match(TRANSLATE_ONLY);
    if (m === null) return null;
    x += Number(m[1]);
    y += Number(m[2] ?? '0');
  }
  return { x, y };
}

/**
 * Measures the pristine render into a session, or refuses (null) when there
 * is nothing measurable — no svg, no viewBox, or a zero-size client box
 * (hidden host, or unstubbed jsdom).
 */
export function beginManualLayout(
  host: HTMLElement,
  binding: FlowchartSvgBinding,
): ManualLayoutSession | null {
  const svg = host.querySelector('svg');
  if (svg === null) return null;
  const vb = viewBoxOf(svg);
  const svgRect = svg.getBoundingClientRect();
  if (vb === null || vb.w <= 0 || svgRect.width <= 0) return null;
  const scale = svgRect.width / vb.w;
  const origin = { x: svgRect.left, y: svgRect.top };
  const boxes = new Map<string, Box>();
  const auto = new Map<string, Pt>();
  const base = new Map<string, string>();
  for (const [id, el] of binding.nodeEls) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue; // unmeasurable node: stays auto
    const box: Box = {
      cx: (r.left + r.width / 2 - origin.x) / scale + vb.x,
      cy: (r.top + r.height / 2 - origin.y) / scale + vb.y,
      halfW: r.width / 2 / scale,
      halfH: r.height / 2 / scale,
    };
    boxes.set(id, box);
    auto.set(id, { x: box.cx, y: box.cy });
    base.set(id, el.getAttribute('transform') ?? '');
  }
  return { svg, scale, origin, vb, boxes, auto, base };
}

/** Client (viewport) coordinates → plane coordinates. */
export function clientToPlane(session: ManualLayoutSession, client: Pt): Pt {
  return {
    x: (client.x - session.origin.x) / session.scale + session.vb.x,
    y: (client.y - session.origin.y) / session.scale + session.vb.y,
  };
}

/** Sets one node's transform for a target center. False = left untouched. */
function setNodeTransform(
  session: ManualLayoutSession,
  el: SVGGElement,
  id: string,
  center: Pt,
): boolean {
  const box = session.boxes.get(id);
  const autoCenter = session.auto.get(id);
  if (box === undefined || autoCenter === undefined) return false;
  if (accumulatedTranslate(el, session.svg) === null) return false;
  box.cx = center.x;
  box.cy = center.y;
  const dx = round2(center.x - autoCenter.x);
  const dy = round2(center.y - autoCenter.y);
  // Pure-translate ancestry means parent units ARE plane units, so the delta
  // transfers 1:1; appending after the remembered base keeps mermaid's own
  // placement and makes re-application idempotent.
  const base = session.base.get(id) ?? '';
  el.setAttribute('transform', `${base} translate(${dx}, ${dy})`.trim());
  return true;
}

/** Straightens one bound edge between its endpoints' current borders. */
export function rerouteEdge(
  session: ManualLayoutSession,
  bound: FlowchartSvgBinding['edgeEls'][number],
): void {
  if (bound.from === bound.to) return; // self-loop: mermaid's path or nothing
  const from = session.boxes.get(bound.from);
  const to = session.boxes.get(bound.to);
  if (from === undefined || to === undefined) return; // unbound endpoint: untouched
  const shift = accumulatedTranslate(bound.el, session.svg);
  if (shift === null) return; // transformed cluster root we can't map: untouched
  const a = rectBorderPoint(from, { x: to.cx, y: to.cy });
  const b = rectBorderPoint(to, { x: from.cx, y: from.cy });
  bound.el.setAttribute(
    'd',
    `M${round2(a.x - shift.x)},${round2(a.y - shift.y)}L${round2(b.x - shift.x)},${round2(b.y - shift.y)}`,
  );
  // marker-start/marker-end are separate attributes on this same element —
  // untouched by the d write above (edgeMarker.ts:133/136).
  moveEdgeLabel(session, bound, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

function moveEdgeLabel(
  session: ManualLayoutSession,
  bound: FlowchartSvgBinding['edgeEls'][number],
  mid: Pt,
): void {
  // The path carries the bare edge id in data-id (edges.js:859); the label's
  // inner g.label carries the same (edges.js:84). Ids are [A-Za-z0-9_.-] plus
  // our L_/counter framing — safe inside a quoted attribute selector.
  const edgeId = bound.el.getAttribute('data-id');
  if (edgeId === null) return;
  const inner = session.svg.querySelector(`g.edgeLabels g.label[data-id="${edgeId}"]`);
  const outer = inner?.parentElement ?? null; // g.edgeLabel — what mermaid translates
  if (outer === null) return;
  const shift = accumulatedTranslate(outer, session.svg);
  if (shift === null) return;
  outer.setAttribute(
    'transform',
    `translate(${round2(mid.x - shift.x)}, ${round2(mid.y - shift.y)})`,
  );
}

/** Moves one node and re-routes its incident bound edges (drag frames). */
export function moveNode(
  session: ManualLayoutSession,
  binding: FlowchartSvgBinding,
  id: string,
  center: Pt,
): void {
  const el = binding.nodeEls.get(id);
  if (el === undefined) return;
  if (!setNodeTransform(session, el, id, center)) return;
  for (const bound of binding.edgeEls) {
    if (bound.from === id || bound.to === id) rerouteEdge(session, bound);
  }
}

/**
 * Full application after a render: place every stored node, then straighten
 * EVERY bound edge — moved or not — so manual mode has one consistent look
 * instead of a patchwork of curves and lines.
 */
export function applyManualLayout(
  session: ManualLayoutSession,
  binding: FlowchartSvgBinding,
  positions: Map<string, Pt>,
): void {
  for (const [id, pt] of positions) {
    const el = binding.nodeEls.get(id);
    if (el !== undefined) setNodeTransform(session, el, id, pt);
  }
  for (const bound of binding.edgeEls) rerouteEdge(session, bound);
}

/**
 * The one-call read-only pipeline for view surfaces (MermaidDiagram): parse,
 * check the marker, bind, measure, apply. Silently a no-op for non-flowcharts,
 * auto-mode diagrams, and unmeasurable hosts.
 */
export function applyStoredManualLayout(host: HTMLElement, code: string): void {
  const model: FlowchartModel | null = parseFlowchart(code);
  if (model === null || !isManualLayout(model)) return;
  const binding = bindFlowchartSvg(host, model);
  const session = beginManualLayout(host, binding);
  if (session === null) return;
  applyManualLayout(session, binding, storedPositions(model));
}
```

- [ ] **Step 4: Run the module tests**

Run: `pnpm test:run src/mermaid/flowchart/manualLayout.test.ts`
Expected: all pass. The anchor arithmetic in the apply test (`M60,26.25L120,63.75`) is hand-computed — if it fails, suspect the implementation before the test.

- [ ] **Step 5: Wire the pipeline into `StructuralEditor.tsx`**

Add imports and a session ref:

```tsx
import { isManualLayout, storedPositions } from './model';
import { applyManualLayout, beginManualLayout, type ManualLayoutSession } from './manualLayout';
```

```tsx
const manualRef = useRef<ManualLayoutSession | null>(null);
const manual = model !== null && isManualLayout(model);
```

At the END of the bind effect's `.then` callback (after the edge wiring loop), add:

```tsx
      // Manual layout (M29.42): after render + bind, take over geometry.
      // Everything below is imperative DOM work inside the React-free svg
      // subtree — same rules as the handler wiring above.
      manualRef.current = null;
      if (isManualLayout(model)) {
        const session = beginManualLayout(hostRef.current, binding);
        if (session !== null) {
          applyManualLayout(session, binding, storedPositions(model));
          manualRef.current = session;
        }
      }
```

(`manual` the boolean is for JSX/gesture branches in Task G4; the effect re-derives from `model` directly so its dependency array stays `[code, model]`.)

- [ ] **Step 6: Wire the read-only pipeline into `MermaidDiagram.tsx`**

View mode must honor stored positions too — otherwise a manual diagram snaps to auto layout every time the block leaves edit mode, and after every reload. Add:

```tsx
import { applyStoredManualLayout } from './flowchart/manualLayout';
```

Give the svg container a ref and run the pipeline after each successful render. The container div (the one that receives the svg markup via React's raw-HTML prop) gains `ref={bodyRef}`:

```tsx
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Manual layout in view mode (M29.42): the raw-HTML subtree is opaque to
  // React, so attribute edits in there survive re-renders; the effect re-runs
  // exactly when the injected svg is replaced.
  useEffect(() => {
    if (result === null || !result.ok || bodyRef.current === null) return;
    applyStoredManualLayout(bodyRef.current, code);
  }, [result, code]);
```

Note what this deliberately does not fix: `onExpand(svg)` hands the lightbox the *raw* svg string — the lightbox shows auto layout (risk ledger item 9).

- [ ] **Step 7: One view-mode test**

Append to `src/mermaid/MermaidDiagram.test.tsx` (reusing that file's existing render mock; the prototype stub pattern is required here because the component measures inside its own effect, before the test can touch elements):

```tsx
it('applies stored manual positions in view mode (M29.42)', async () => {
  const MANUAL_SVG = [
    '<svg viewBox="0 0 200 100">',
    '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
    '<g class="node" id="flowchart-B-1" transform="translate(130, 70)"><rect/></g>',
    '<path class="flowchart-link" id="L_A_B_0" data-id="L_A_B_0" d="M30,25C60,40 90,50 120,65" marker-end="url(#e)"/>',
    '</svg>',
  ].join('');
  renderMock.mockResolvedValue({ ok: true, svg: MANUAL_SVG });

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
    render(
      <MermaidDiagram
        code={
          'flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 50,20\n  A[Start] --> B[End]'
        }
      />,
    );
    await waitFor(() => {
      expect(document.getElementById('flowchart-A-0')?.getAttribute('transform')).toBe(
        'translate(30, 20) translate(20, 0)',
      );
    });
    expect(document.getElementById('L_A_B_0')?.getAttribute('d')).toBe('M60,26.25L120,63.75');
    expect(document.getElementById('L_A_B_0')?.getAttribute('marker-end')).toBe('url(#e)');
  } finally {
    Element.prototype.getBoundingClientRect = original;
  }
});
```

(Adapt `renderMock` to that file's actual mock handle name; keep the try/finally restore — a leaked prototype stub poisons every later test in the file.)

- [ ] **Step 8: Run everything touched, lint, commit**

```bash
pnpm test:run src/mermaid/ && pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/manualLayout.ts src/mermaid/flowchart/manualLayout.test.ts \
        src/mermaid/flowchart/StructuralEditor.tsx src/mermaid/MermaidDiagram.tsx \
        src/mermaid/MermaidDiagram.test.tsx
git commit -m "feat(mermaid): manual mode — our transforms, our straight edges, honest degradation (M29.42)"
```

---

### Task G4: Drag places nodes; connect moves to a handle; the toggle (M29.43)

**Files:**
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx`
- Modify: `src/mermaid/flowchart/StructuralEditor.test.tsx`
- Modify: `src/mermaid/DiagramToolbar.tsx` (Stage D file — contract-scoped, see contingency in Step 5)

**Gesture design, stated before code:** in manual mode, dragging a node **moves** it — transform-only DOM updates every frame through `moveNode`, one `setNodePosition` → one `onChangeCode` → one undo step on release. A movement under 3px is not a drag: click-select and double-click-rename keep working unchanged. Connecting — which *was* the node-drag gesture — moves to a dedicated **connect handle**: a small dot that appears at the node's right edge on hover (manual mode only); dragging from the dot runs the existing ghost-line connect flow untouched. Auto mode changes nothing: drag still connects, exactly as shipped in M29.18.

- [ ] **Step 1: Write the failing tests**

Append to `src/mermaid/flowchart/StructuralEditor.test.tsx` a new describe. Two test-infrastructure pieces are load-bearing and documented here once: (1) jsdom pointer events drop coordinates, so drags dispatch `MouseEvent`s under pointer-event names; (2) the component measures inside its bind effect — before the test can reach any element — so rects come from a keyed `Element.prototype` stub installed for the whole describe. Also extend the file's imports with `beforeEach, afterEach` from vitest and `import { renderMermaid } from '../render';` (the mocked fn).

```tsx
describe('manual mode (M29.42–.43)', () => {
  const MANUAL_SVG = [
    '<svg viewBox="0 0 200 100">',
    '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
    '<g class="node" id="flowchart-B-1" transform="translate(130, 70)"><rect/></g>',
    '<g class="node" id="flowchart-C-2" transform="translate(170, 20)"><rect/></g>',
    '<path class="flowchart-link" id="L_A_B_0" data-id="L_A_B_0" d="M30,25C60,40 90,50 120,65" marker-end="url(#e)"/>',
    '</svg>',
  ].join('');

  const MANUAL_CODE = 'flowchart TD\n  %% cerebro:layout manual\n  A[Start] --> B[End]';

  const RECTS: Record<string, { left: number; top: number; width: number; height: number }> = {
    svg: { left: 0, top: 0, width: 200, height: 100 },
    'flowchart-A-0': { left: 20, top: 10, width: 20, height: 20 },
    'flowchart-B-1': { left: 120, top: 60, width: 20, height: 20 },
    'flowchart-C-2': { left: 160, top: 10, width: 20, height: 20 },
  };

  let restoreRect: () => void;
  beforeEach(() => {
    vi.mocked(renderMermaid).mockResolvedValue({ ok: true, svg: MANUAL_SVG });
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const key = this.tagName.toLowerCase() === 'svg' ? 'svg' : this.id;
      const r = RECTS[key] ?? { left: 0, top: 0, width: 0, height: 0 };
      return {
        ...r,
        right: r.left + r.width,
        bottom: r.top + r.height,
        x: r.left,
        y: r.top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    restoreRect = () => {
      Element.prototype.getBoundingClientRect = original;
    };
  });
  afterEach(() => {
    restoreRect();
    vi.mocked(renderMermaid).mockResolvedValue({ ok: true, svg: FIXTURE_SVG });
  });

  /**
   * jsdom has no PointerEvent constructor, and its pointer-event fallback
   * drops clientX/Y (the Stage C ghost NaN guards exist for this). MouseEvent
   * under a pointer-event type name carries coordinates and reaches
   * addEventListener('pointerdown') listeners just fine.
   */
  function firePointer(
    target: EventTarget,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    coords: { clientX: number; clientY: number },
  ): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...coords }));
  }

  it('applies stored positions after render', async () => {
    render(
      <StructuralEditor
        code={
          'flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 50,20\n  A[Start] --> B[End]'
        }
        onChangeCode={() => {}}
      />,
    );
    await waitFor(() =>
      expect(document.getElementById('flowchart-A-0')?.getAttribute('transform')).toBe(
        'translate(30, 20) translate(20, 0)',
      ),
    );
    expect(document.getElementById('L_A_B_0')?.getAttribute('d')).toBe('M60,26.25L120,63.75');
  });

  it('drag moves the node live and writes ONE position on release', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={MANUAL_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    const a = document.getElementById('flowchart-A-0')!;

    firePointer(a, 'pointerdown', { clientX: 30, clientY: 20 }); // grab dead-center
    firePointer(window, 'pointermove', { clientX: 80, clientY: 20 });
    // Mid-drag: transform-only — the DOM moved, the file did not.
    expect(a.getAttribute('transform')).toBe('translate(30, 20) translate(50, 0)');
    expect(onChangeCode).not.toHaveBeenCalled();

    firePointer(window, 'pointerup', { clientX: 80, clientY: 20 });
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 80,20\n  A[Start] --> B[End]',
    );
  });

  it('a sub-3px wiggle is a click, not a move', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={MANUAL_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    const a = document.getElementById('flowchart-A-0')!;
    firePointer(a, 'pointerdown', { clientX: 30, clientY: 20 });
    firePointer(window, 'pointermove', { clientX: 31, clientY: 21 });
    firePointer(window, 'pointerup', { clientX: 31, clientY: 21 });
    expect(onChangeCode).not.toHaveBeenCalled();
    expect(a.getAttribute('transform')).toBe('translate(30, 20)');
  });

  it('the connect handle appears on hover and drags a new edge', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={MANUAL_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    const a = document.getElementById('flowchart-A-0')!;
    fireEvent.mouseEnter(a);
    const handle = a.querySelector('.cerebro-connect-handle');
    expect(handle).toBeTruthy();

    firePointer(handle!, 'pointerdown', { clientX: 40, clientY: 20 });
    const b = document.getElementById('flowchart-B-1');
    document.elementFromPoint = () => b;
    firePointer(window, 'pointerup', { clientX: 130, clientY: 70 });
    expect(onChangeCode).toHaveBeenCalledWith(`${MANUAL_CODE}\n  A --> B`);
  });

  it('the toggle writes the marker on, removes only the marker off', async () => {
    const onChangeCode = vi.fn();
    const { rerender } = render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-layout: On' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  %% cerebro:layout manual\n  A[Start] --> B[End]',
    );

    onChangeCode.mockClear();
    rerender(
      <StructuralEditor
        code={
          'flowchart TD\n  %% cerebro:layout manual\n  %% cerebro:pos A 80,20\n  A[Start] --> B[End]'
        }
        onChangeCode={onChangeCode}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-layout: Off' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  %% cerebro:pos A 80,20\n  A[Start] --> B[End]', // positions survive
    );
  });

  it('a new node in manual mode gets a position', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={MANUAL_CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(screen.getByRole('button', { name: '+ Node' }));
    const out = onChangeCode.mock.calls[0][0] as string;
    expect(out).toContain('n1[New step]');
    // Host rect is zeros under the stub → viewport center degenerates to the
    // plane origin. The invariant under test is "a position exists at all".
    expect(out).toMatch(/%% cerebro:pos .*n1 -?\d+,-?\d+/);
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/flowchart/StructuralEditor.test.tsx`
Expected: the new describe fails (no toggle button, drag still connects); every pre-existing test still passes — if an old test broke, stop and understand why before touching anything else.

- [ ] **Step 3: Implement the gestures in `StructuralEditor.tsx`**

Extend imports:

```tsx
import { clientToPlane, moveNode } from './manualLayout';
import { setManualLayout, setNodePosition } from './ops'; // extend the existing ops import
```

New refs and helpers (component scope, above the effects):

```tsx
  const moveGesture = useRef<{
    id: string;
    grab: { x: number; y: number };
    startClient: { x: number; y: number };
    moved: boolean;
  } | null>(null);

  /** Starts the ghost-line connect gesture — extracted verbatim from the old
   *  node pointerdown body so the connect handle can reuse it. */
  const beginConnect = (id: string, e: PointerEvent) => {
    const host = hostRef.current;
    if (host === null) return;
    const hostBox = host.getBoundingClientRect();
    dragFrom.current = id;
    setGhost({
      x1: e.clientX - hostBox.left,
      y1: e.clientY - hostBox.top,
      x2: e.clientX - hostBox.left,
      y2: e.clientY - hostBox.top,
    });
  };

  /** Starts a manual-mode move gesture. */
  const beginMove = (id: string, e: PointerEvent) => {
    const session = manualRef.current;
    if (session === null) return;
    const cx = Number.isFinite(e.clientX) ? e.clientX : 0;
    const cy = Number.isFinite(e.clientY) ? e.clientY : 0;
    const box = session.boxes.get(id);
    if (box === undefined) return;
    const plane = clientToPlane(session, { x: cx, y: cy });
    moveGesture.current = {
      id,
      grab: { x: plane.x - box.cx, y: plane.y - box.cy },
      startClient: { x: cx, y: cy },
      moved: false,
    };
  };

  /** addNode, plus a viewport-center position when manual mode is on — the
   *  composed model serializes once, so the whole thing is one undo step. */
  const addNodeForMode = (): { model: FlowchartModel; id: string } => {
    const added = addNode(model!, 'New step');
    const session = manualRef.current;
    const host = hostRef.current;
    if (!manual || session === null || host === null) return added;
    const rect = host.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const cx = left + Math.min(rect.width, Math.max(window.innerWidth - left, 0)) / 2;
    const cy = top + Math.min(rect.height, Math.max(window.innerHeight - top, 0)) / 2;
    const pt = clientToPlane(session, { x: cx, y: cy });
    return { model: setNodePosition(added.model, added.id, pt), id: added.id };
  };
```

(`FlowchartModel` joins the type imports from `./model`.)

In the bind effect's node loop, replace the existing `el.addEventListener('pointerdown', …)` block with a mode branch, and add the manual-mode affordances:

```tsx
        el.style.cursor = manual ? 'move' : 'pointer';
        // addEventListener, not `.onpointerdown =` — see the M29.18 jsdom note.
        el.addEventListener('pointerdown', (e: PointerEvent) => {
          if (manual) {
            beginMove(id, e);
            return;
          }
          beginConnect(id, e);
        });

        if (manual) {
          // Connect handle: a dot at the node's right edge, hover-only.
          // Node shapes are drawn centered on the group origin (nodes.ts:97),
          // so node-local (halfW, 0) is the right border's midpoint and the
          // handle rides along when the group is translated.
          el.addEventListener('mouseenter', () => {
            const session = manualRef.current;
            if (session === null || el.querySelector('.cerebro-connect-handle') !== null) return;
            const box = session.boxes.get(id);
            if (box === undefined) return;
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('class', 'cerebro-connect-handle');
            dot.setAttribute('cx', String(Math.round(box.halfW)));
            dot.setAttribute('cy', '0');
            dot.setAttribute('r', '5');
            dot.setAttribute('fill', 'var(--cortex-500)');
            dot.style.cursor = 'crosshair';
            dot.addEventListener('pointerdown', (de: Event) => {
              de.stopPropagation();
              beginConnect(id, de as PointerEvent);
            });
            el.appendChild(dot);
          });
          el.addEventListener('mouseleave', () => {
            el.querySelector('.cerebro-connect-handle')?.remove();
          });
        }
```

In the window-listener effect, handle the move gesture *before* the existing connect logic. Prepend to `onPointerMove`:

```tsx
      const gesture = moveGesture.current;
      if (gesture !== null) {
        const session = manualRef.current;
        const binding = bindingRef.current;
        if (session === null || binding === null) return;
        const cx = Number.isFinite(e.clientX) ? e.clientX : 0;
        const cy = Number.isFinite(e.clientY) ? e.clientY : 0;
        if (!gesture.moved) {
          if (Math.hypot(cx - gesture.startClient.x, cy - gesture.startClient.y) < 3) return;
          gesture.moved = true;
        }
        const plane = clientToPlane(session, { x: cx, y: cy });
        // Transform + incident-edge writes only — no React state, no model
        // churn. 60fps lives or dies right here (spike question c).
        moveNode(session, binding, gesture.id, {
          x: plane.x - gesture.grab.x,
          y: plane.y - gesture.grab.y,
        });
        return;
      }
```

Prepend to `onPointerUp`:

```tsx
      const gesture = moveGesture.current;
      if (gesture !== null) {
        moveGesture.current = null;
        if (gesture.moved) {
          const session = manualRef.current;
          const box = session?.boxes.get(gesture.id);
          if (session != null && box !== undefined) {
            // The one model write of the whole drag: one onChangeCode, one
            // undo step. The re-render it triggers re-runs the pipeline from
            // the stored positions, converging on exactly what's on screen.
            apply(setNodePosition(model, gesture.id, { x: box.cx, y: box.cy }));
          }
        }
        return;
      }
```

(The window-listener effect's dependency array `[model]` already covers this: `manual` derives from `model`, the sessions ride in refs, and the eslint-disable comment there already explains the deliberate closure.)

Route the two node-creation call sites through `addNodeForMode`:

```tsx
        {/* toolbar "+ Node" */}
        onClick={() => apply(addNodeForMode().model)}
```

```tsx
        {/* mini-toolbar "Add connected node" */}
        onClick={() => {
          if (validSelected === null) return;
          const added = addNodeForMode();
          apply(addEdge(added.model, validSelected, added.id));
        }}
```

And the connect gesture's empty-canvas drop (inside the existing `onPointerUp` connect branch) — swap its `addNode(model, 'New step')` for `addNodeForMode()` so a node dropped on canvas in manual mode also lands with a position.

- [ ] **Step 4: The toggle in the structural toolbar**

Add to the toolbar row in `StructuralEditor.tsx` (after the Layout button, with a divider), following the house pattern of *showing current state, click to flip* (`Layout: Dagre` precedent):

```tsx
        <span className="mx-0.5 h-4 w-px bg-n-100" />
        <button
          type="button"
          aria-label={manual ? 'Auto-layout: Off' : 'Auto-layout: On'}
          onClick={() => apply(setManualLayout(model, !manual))}
          className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
        >
          {manual ? 'Auto-layout: Off' : 'Auto-layout: On'}
        </button>
```

Turning manual ON with no stored positions is intentionally undramatic: the layout doesn't move (deltas are zero) — the edges straighten, drags start writing positions. Turning it OFF removes only the marker; the positions comment stays for the next time (spec D7).

- [ ] **Step 5: The toggle in `DiagramToolbar` (Stage D surface)**

Stage D's `DiagramToolbar` (spec D1/D9) hosts the layout menu on the full-screen editor. Add an "Auto-layout" item to that menu, wired through the same channel the toolbar's other layout controls use: read `parseFlowchart(code)`, disable the item when null, otherwise emit `serialize(setManualLayout(model, !isManualLayout(model)))` through `onChangeCode`. Label/checkmark semantics per that file's existing menu conventions.

**Contingency:** this plan is written in parallel with Stage D. If `src/mermaid/DiagramToolbar.tsx` does not exist (or has no layout menu) when this task executes, SKIP this step, say so in the commit body (`DiagramToolbar integration deferred to Stage D merge — structural toolbar carries the toggle`), and file the hookup as a one-line follow-up on the Stage D checklist. The StructuralEditor button from Step 4 already delivers the full capability everywhere the editor renders.

- [ ] **Step 6: Run everything, lint, commit**

```bash
pnpm test:run src/mermaid/ && pnpm lint && pnpm typecheck
git add src/mermaid/
git commit -m "feat(mermaid): drag places nodes, connect moves to a handle, auto-layout toggles (M29.43)"
```

---

### Task G5: e2e — the manual loop against real mermaid, then the full gate (M29.44)

**Files:**
- Modify: `e2e/diagrams.spec.ts` (fifth test)

- [ ] **Step 1: Write the e2e**

One deliberate deviation from the phase description, stated up front: the scope says "reload the page → node renders at the stored position", but `page.reload()` resets the **in-memory mock fs** — the fake disk would forget the drag along with everything else, testing nothing. The spec instead *closes and reopens the document* (navigate away, navigate back): a fresh read from the (persisting) mock disk through the full parse→render→apply pipeline in **view mode** — the same code path a real reload exercises, minus destroying the storage under test. A true cold-start check belongs to a live run (Step 3).

```ts
// M29.44: manual layout round-trips — toggle off, drag, positions hit the
// file, reopening renders them, toggle on hands geometry back to mermaid.
test('manual layout: drag writes positions; they survive reopen; auto returns', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) {
    await demoButton.click();
  }

  const openDoc = async (name: string) => {
    await page.keyboard.press('ControlOrMeta+k');
    const quickOpenInput = page.getByTestId('quick-open-input');
    await expect(quickOpenInput).toBeVisible();
    await quickOpenInput.fill(name);
    await page.getByTestId('quick-open-result').filter({ hasText: name }).first().click();
  };
  const readFile = () =>
    page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md'));

  await openDoc('Systems map');
  await page.getByTestId('mermaid-block').first().getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('structural-host').locator('svg').waitFor({ timeout: 20_000 });

  // -- Auto-layout off --------------------------------------------------
  await page.getByRole('button', { name: 'Auto-layout: On' }).click();
  await page.getByRole('button', { name: 'Auto-layout: Off' }).waitFor({ timeout: 15_000 });
  await page.getByTestId('structural-host').locator('svg').waitFor({ timeout: 20_000 });

  // -- Drag Build 120 right, 60 down ------------------------------------
  const build = page.locator('[id*="flowchart-Build-"]').first();
  const box = (await build.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 });
  await page.mouse.up();

  // The file holds the marker and a Build position.
  await expect.poll(readFile, { timeout: 15_000 }).toContain('%% cerebro:layout manual');
  await expect.poll(readFile, { timeout: 15_000 }).toMatch(/%% cerebro:pos .*Build -?\d+,-?\d+/);

  // -- Reopen: view mode renders the stored position ---------------------
  // (Not page.reload(): that resets the in-memory mock fs — see plan note.)
  await openDoc('Distillation notes'); // any other doc — leave Systems map
  await openDoc('Systems map');
  const viewBuild = page
    .getByTestId('mermaid-diagram')
    .first()
    .locator('[id*="flowchart-Build-"]')
    .first();
  // Our appended delta rides after mermaid's own translate: two translates.
  await expect(viewBuild).toHaveAttribute('transform', /translate\([^)]*\)\s*translate\(/, {
    timeout: 20_000,
  });

  // -- Auto-layout back on: marker gone, positions retained --------------
  await page.getByTestId('mermaid-block').first().getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('structural-host').locator('svg').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Auto-layout: Off' }).click();
  await expect.poll(readFile, { timeout: 15_000 }).not.toContain('%% cerebro:layout manual');
  await expect.poll(readFile, { timeout: 15_000 }).toContain('%% cerebro:pos');
});
```

Adaptation notes for the implementer, so failures get diagnosed instead of patched blind: the `__cerebroMockFs` global declaration and the exact mock-fs key convention must be copied from this spec file's existing tests (they already read the same path); `'Distillation notes'` stands in for "any other quick-openable doc" — pick whatever the corpus reliably offers; if the drag lands on a *sub-element* of the group so `mouse.down` misses the pointerdown listener, target the group's `rect` child instead. If the double-translate assertion proves flaky because mermaid emits transforms with different spacing, loosen to `/translate\(.*translate\(/` — but confirm the first form against the real DOM before loosening anything.

- [ ] **Step 2: Run the new spec, then the full gate**

```bash
PORT=5273 pnpm e2e -- diagrams.spec.ts
```
Expected: 5 passed.

```bash
pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage && \
PORT=5273 pnpm e2e && \
(cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings)
```
Expected: all green, coverage ratchet intact.

- [ ] **Step 3: Live sanity pass (not automatable, do not skip)**

Against `pnpm dev` in a real browser: toggle a diagram manual, drag three nodes around, toggle off, toggle back on, and *look* — arrowhead orientation, label placement, the connect handle's feel, and the documented degradations (subgraph child dragged outside its cluster; a self-loop node moved) behaving as *described* rather than worse. Record anything surprising in the PR description. A true cold-reload check (positions surviving an actual process restart) needs the Tauri app or a real vault — note in the PR whether it was done.

- [ ] **Step 4: Commit**

```bash
git add e2e/diagrams.spec.ts
git commit -m "test(mermaid): manual layout round-trips through drag, disk, and reopen (M29.44)"
```

---

## Stage G exit criteria

- **Gate honored:** M29.40's findings are written into this file's NOTES with an explicit verdict per criterion; on any NO, work stopped at the gate and the coordinator decided scope. No spike artifact shipped.
- **Format:** `%% cerebro:pos` (one line, all positions, id-sorted, integer coords) and `%% cerebro:layout manual` are understood line kinds; malformed variants stay opaque byte-for-byte; untouched marker lines round-trip byte-identically; `setNodePosition` / `clearPositions` / `setManualLayout` are surgical (one line each), unit-proven; `deleteNode` leaves no zombie coordinates.
- **Pipeline:** in manual mode, stored nodes render at their positions (delta translate appended to mermaid's own), every bindable edge is a straight border-to-border segment with markers intact and its label at the midpoint; unbound edges, self-loops, and non-translate-ancestry elements keep mermaid's geometry untouched; view mode (`MermaidDiagram`) honors positions identically.
- **Interaction:** manual-mode drag moves at transform-only speed and commits exactly one `onChangeCode` (= one undo step) on release; sub-3px is a click; connect lives on the hover handle; auto-mode behavior is byte-for-byte unchanged (old tests untouched and green); new nodes in manual mode carry a position; the toggle shows current state and flips it, retaining positions on OFF.
- **e2e:** toggle→drag→file→reopen→toggle-back proven against real mermaid; full gate green; coverage ratchet intact.
- **Honesty:** the limitations below appear in the PR description verbatim or tightened — never softened.

## Known limitations (ship these words with the PR)

1. Manual mode replaces mermaid's curved/orthogonal edge routing with straight lines for every edge it can bind; auto and manual modes look different by design.
2. Subgraphs: dragging a child moves only that child; the cluster rectangle does not resize or follow. Children can sit visually outside their cluster. Intra-cluster edges under transformed roots, edges with unbindable ids, self-loops, and handDrawn-look edges keep mermaid's original paths and can visibly disconnect from moved nodes.
3. Border anchors use the node's bounding box — non-rectangular shapes get slightly imperfect arrow contact points.
4. Parallel edges between the same pair overlap as identical segments in manual mode.
5. Nodes without stored positions re-flow with auto layout on every edit; pinned and unpinned nodes coexist but the unpinned ones drift.
6. The lightbox (and any surface fed the raw svg string) shows auto layout.
7. ELK diagrams support manual mode but diverge most visually from their auto rendering.

## Plan self-review (author)

- Spec coverage: D3's `pos-comment` (grammar widened with the companion `layout-mode` marker the D7 flow requires), D7 in full (spike gate, exit criteria, fallback branch, stop protocol, positions retained on toggle-off, one-commit-per-drag), D9's Auto-layout control (structural toolbar + contract-scoped DiagramToolbar step), D10 surgical invariants (every op one-line, byte-round-trip proofs). ✓
- Names consistent throughout: `setNodePosition`, `clearPositions`, `setManualLayout`, `pos-comment`, `layout-mode`, `isManualLayout`, `storedPositions`, `beginManualLayout`, `applyManualLayout`, `moveNode`, `rectBorderPoint`, `clientToPlane`, `accumulatedTranslate`, `applyStoredManualLayout`. ✓
- No placeholders: all geometry, parsing, ops, gesture, and test code is written in full; the only intentionally-open block is the NOTES template below, which exists to be filled by M29.40. ✓
- Vendored citations spot-verified against `docs/examples/mermaid-develop` at authoring time (edges.js:81/84/265/292/818-829/859-860; edgeMarker.ts:13/133/136; createGraph.ts:29-40; nodes.ts:97; flowDb.ts:1259). ✓

---

## NOTES — M29.40 spike findings (filled in by the implementer, committed with the M29.40 commit)

**Method.** Seven throwaway Playwright probes against the real app on real mermaid
(`e2e/_spike-manual-layout.spec.ts`, deleted with this commit): dagre flowchart, ELK
flowchart, icon+image nodes, subgraph nesting, edge variants (`<-->` / `-.->` / `==>` /
self-loop / parallel pair), `look: handDrawn`, and a 50-node/60-edge perf loop. All seven
green. Every screenshot was re-fitted (viewBox rewritten to the content bbox, rendered at
3–6×) before being eyeballed, because at the shipped size the arrowheads are 8px.

One deliberate departure from the spike snippet in Step 1: geometry was NOT done with
`getBoundingClientRect` + viewBox arithmetic. A node's center in an edge path's own user
space is `pathEl.getScreenCTM().inverse() × nodeEl.getScreenCTM()` applied to the node's
local origin (node shapes are drawn centered on that origin — `nodes.ts:97`). That is exact
under nested group transforms and under CanvasViewport scaling, and it is what Task G3
should use; the snippet's arithmetic silently assumes node plane == svg viewBox plane,
which is true for every diagram measured here but is not guaranteed by anything.

- **Date / machine:** 2026-08-09, Apple Silicon macOS (Darwin 24.6.0), headless Chromium
  via Playwright against `PORT=5273 pnpm dev`. **Bundled mermaid 11.16.0** (the DOM contract
  above is cited against vendored 11.16.1; every version-sensitive claim below was
  re-measured on the bundled build). Machine load average across the runs: 1-min 7.4–19.2,
  5-min 13–18, 15-min 24 — five or six other agent sessions were live on this box, so the
  perf figures below are a **floor, not the real ceiling**.

- **(a) Post-render re-layout (dagre): YES.** `flowchart TD Idea→Build→Review→{Done,Build}`,
  demo corpus fence 1. Appending ` translate(120, 80)` to the node group's existing
  `transform` moved it by exactly (120, 80) — measured delta `{dx: 120, dy: 80}`, no rounding
  drift, no re-render. All four edges re-routed to `M x1,y1 L x2,y2` between bbox-border
  anchors: every one has `getTotalLength()` equal to the analytic segment length to <0.5px
  (so nothing of the old Bézier survives in the `d`), each `path.flowchart-link` has zero
  child elements, and `g.edgePaths` holds **exactly one path per edge** — there is no second
  overlay element, no hit-target path, no line-jump group, so there is no fragment of the old
  curve to leave behind. Both edge labels ("rework", "ship") moved to the new midpoints by
  setting the transform on the label's PARENT `g.edgeLabel` (mermaid's own move — `edges.js:292`).
  Arrowheads render at the segment ends, oriented along the segment, in every case: verified
  by eye at 6× on `Idea→Build` (a diagonal, the orientation-sensitive one), `Review→Build`,
  `Build→Review` (lands on the diamond's top vertex) and `Review→Done`.
  **Clipping: REAL, and noted per the exit criterion.** This diagram's viewBox is
  `0 0 108.625 445.3125` and the svg carries `style="max-width: 108.625px"` with the UA's
  `overflow: hidden`, so a node dragged +120px to the right lands entirely OUTSIDE the box and
  **vanishes**. It is not a partial clip; it is total. It is also entirely a viewBox problem:
  rewriting `viewBox` to the content bbox plus `width`/`height`/`max-width` — three attribute
  writes on the same DOM, no re-render — brought the moved node and its edge back with no
  other change. Task G3 must grow the box; if it does not, the first drag toward any edge of
  a narrow diagram loses the node.
- **(a) Post-render re-layout (ELK): YES.** Demo corpus fence 4 (`config: layout: elk`,
  `flowchart LR A→{B,C}, {B,C}→D, D→E`). Same result: exact (120, 80) translate, all five
  orthogonal ELK routes replaced by clean straight border-to-border segments, all
  `totalLength` == analytic length, arrowheads present and correctly oriented (checked at 3×
  on the two diagonals). Labels: this fence has none. No clipping here — the diagram is wide
  and the moved node stayed inside — but that is luck of the geometry, not a difference in kind.
  Aesthetically ELK is exactly the downgrade risk-ledger item 5 predicts: the orthogonal
  routing is completely gone. It reads as a different diagram, not a nudged one.
- **(b) Markers survive `d` replacement: YES.** Every entry of every `markerReport` across all
  four re-routing probes (dagre 4 edges, ELK 5, icon/image 3, subgraph 5, variants 5) reports
  `survived: true` — `marker-start`/`marker-end` are byte-identical before and after
  `setAttribute('d', …)`, as the DOM contract promised. The pixels agree: arrowheads render in
  every screenshot after replacement. The `url(#…)` resolves to a live `<marker>` in every case;
  it is `orient="auto"`, `markerUnits="userSpaceOnUse"`, `refX=5`, `markerWidth=8` — i.e. the
  `pointEnd` marker (`markers.js:314-330`), and `orient="auto"` is exactly why the arrowheads
  re-orient along the new segment for free. Two notes worth carrying forward: (1) the markers
  are appended to the svg root, NOT inside `<defs>` (`inDefs: false`) — harmless, but anything
  that ever rebuilds the svg subtree must not drop them; (2) `marker-start` is exercised, not
  just assumed: the `A <--> B` probe carries `…-pointStart` and it survives and renders too,
  and `-.->` / `==>` keep their `edge-pattern-dotted` / `edge-thickness-thick` classes and
  render dotted/thick after the `d` swap.
- **(c) 50-node drag perf: YES, with the load caveat stated.** 50 nodes / 60 edges, generated
  through the code overlay. The dragged node is the **highest-degree** node (n5, degree 4), not
  an arbitrary one. Three modes × three rounds, 178 measured frames each:

  | mode | edges re-routed/frame | frame interval avg | p95 | js+layout per frame (avg) |
  |---|---|---|---|---|
  | CONTROL (rAF only, no DOM work) | 0 | 8.33 ms | 10.2–10.3 ms | 0.02 ms |
  | WORK (transform + incident edges) | 4 | 8.29–8.34 ms | 9.9–10.2 ms | 0.24 ms |
  | ALL-60 (absurd worst case) | 60 | 8.29–8.34 ms | 9.8–10.0 ms | 0.62 ms |

  Budget is avg ≤ 16.7 ms / p95 ≤ 33 ms: met with ~2× headroom on the frame interval and ~70×
  on the work itself. The **control is the point**: an empty rAF loop on this machine also runs
  at 8.33 ms, so the frame cadence is the browser's, not ours — our per-frame cost is
  indistinguishable from zero even when re-routing all 60 edges every frame. `js/frame` is the
  synchronous cost of `setAttribute` alone (0.05 ms work / 0.18 ms all-60); `flush/frame` adds a
  forced `getBoundingClientRect()` so the measured window includes the style+layout recalc our
  writes dirtied (0.19 ms / 0.45 ms). Caveats, honestly: headless Chromium drives rAF at 120 Hz
  and does not composite to a real display, so **paint** cost is understated; and the box was at
  load 7–19 throughout, which makes these a floor. Neither caveat is close to mattering — even
  if a real display halved the frame rate and paint tripled the cost, the work is single-digit
  percent of a 16.7 ms budget. Zero React involvement: the loop touches only `transform` and `d`.

- **Surprises / deviations from the plan's assumptions:**
  1. **ELK has NO `g.root`, and its containers hang off the svg, not off a wrapper.** The DOM
     contract's "`createLayoutElementGroups` builds `g.root > (g.clusters, g.edgePaths,
     g.edgeLabels, g.nodes)`" is true for dagre and **false for ELK on 11.16.0**. ELK emits
     `g.subgraphs`, `g.nodes`, `g.edges.edgePaths` (two classes — note `edges`), `g.edgeLabels`
     as **direct children of the `<svg>`**, siblings of the (empty) wrapper `g`, with `g.root`
     absent entirely (`svg.querySelectorAll('g.root').length === 0`). Node ancestry is
     `g.node < g.nodes` flat; edge ancestry is `path < g.edges.edgePaths`. Task G3's
     `accumulatedTranslate` walk must not assume `g.root` exists or that nodes and edges share a
     container. The CTM method above is immune to this and is the recommended fix.
  2. **Subgraphs do NOT nest `g.root`.** A two-cluster dagre diagram still produces exactly ONE
     `g.root`, one flat `g.nodes` holding all five nodes, and one flat `g.edgePaths`; no group in
     any measured diagram carried a `transform` attribute at all. All five edges bound, including
     the two that cross cluster boundaries, and all re-routed cleanly. The `accumulatedTranslate`
     ancestry walk therefore has nothing to accumulate in the common case — build it as a safety
     net, not as the mechanism.
  3. **Risk-ledger item 3 is factually WRONG about `handDrawn`, and the real problem is
     elsewhere and larger.** Measured on 11.16.0: `look: handDrawn` edges ARE still
     `path.flowchart-link` (they merely gain a `transition` class), so the ledger's premise —
     "handDrawn-look edges … render as `g` groups rather than `path.flowchart-link`" — is false.
     What actually breaks is the NODES: handDrawn draws every node as **`g.rough-node`**
     (`class="rough-node default"`, `data-look="handDrawn"`, id scheme unchanged), which is a
     FOURTH class absent from `NODE_GROUP_SELECTOR`. In a handDrawn diagram
     `NODE_GROUP_SELECTOR` matches **zero** nodes. Consequences: (i) Stage G manual layout would
     be a silent no-op on such a diagram — arguably safer than the described visible
     disconnection, but silent; (ii) **pre-existing and outside Stage G**: the structural editor
     is ALREADY inert on handDrawn diagrams on this branch today — no selection, no rename, no
     delete, no drag-to-connect, no link badges — the exact failure M29.39 fixed for icon/image
     nodes, one class short. Nothing in `src/` mentions `rough-node` or `handDrawn`. The app
     exposes no "look" control, so this only reaches users through hand-authored source.
     Reported to the coordinator as a scope decision; it is not a Stage G exit criterion.
  4. **Everything else in the ledger measured as-described, not worse.** Self-loops (`A --> A`)
     do get a bindable id (`L_A_A_0`) but a straight-line router would collapse them to a
     zero-length segment, so they must be skipped by `from === to` — the probe skips them, and
     the loop then stays at the node's old position and visibly detaches, exactly as item 3 says.
     Parallel edges (`B --> C` twice, ids `L_B_C_0` and `L_B_C_2`, matching
     `counterForOccurrence`) both re-route onto the identical segment and stack invisibly —
     item 7, exactly. Bbox anchoring on a diamond lands on the shape's true vertex on the
     vertical axis and inside the outline off-axis — item 8, exactly. Clusters neither move nor
     resize when a child is dragged out — item 4, exactly (and the screenshot of it is not
     pretty, but it is what was promised).
  5. **Icon and image nodes translate correctly.** `g.icon-shape` and `g.image-shape` both
     accept an appended translate with an exact measured delta, and both serve as edge anchors
     through the same bbox path as `g.node`. Use `NODE_GROUP_SELECTOR`, never bare `g.node` —
     the spike snippet in Step 1 above uses `g.node[id*="flowchart-"]` and would have silently
     dropped both.
  6. **Label z-order.** `g.edgeLabels` precedes `g.nodes` in document order, so an edge label
     moved to a midpoint that happens to fall on a node renders BEHIND that node. Cosmetic,
     visible in the variants screenshot, not a blocker.
  7. **The naive spike-snippet id regex is fine.** `data-id` on the path is the bare
     `L_<from>_<to>_<n>` with no render-id prefix, and `g.edgeLabels g.label[data-id="…"]` keyed
     off the same string found the label for every edge in every probe. Both plan claims hold on
     11.16.0.

- **Verdict:** **PROCEED to M29.41+** — (a-dagre) YES, (a-ELK) YES, (b) YES, (c) YES.
  Two conditions the coordinator must carry into G2+: Task G3 **must** grow the svg viewBox
  (and `width`/`height`/`max-width`) or the first outward drag on a narrow diagram makes the
  node disappear; and surprise 3 (`g.rough-node`) is a risk-ledger inaccuracy whose real form
  is a pre-existing structural-editor defect outside this stage — reported, awaiting a scope
  decision, not fixed here.
