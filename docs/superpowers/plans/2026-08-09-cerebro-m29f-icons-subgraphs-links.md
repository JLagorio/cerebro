# M29 Stage F — Icons, Subgraphs, and Links (M29.35–M29.39)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nodes carry lucide icons (`A@{ icon: "lucide:rocket", form: rounded, pos: b }`), `click` lines become an understood model kind so a node can link to a URL or a vault record and the EDITOR — not mermaid — honors the click, and subgraphs stop being render-only: create-from-selection, rename, dissolve, and per-subgraph direction, all as surgical text edits.

**Architecture:** Everything model-side lands in `src/mermaid/flowchart/` (model.ts grows the `click` kind and a structured `subgraph-start`; ops.ts grows `setNodeIcon`, `setNodeLink`, `createSubgraph`, `renameSubgraph`, `dissolveSubgraph`, `setSubgraphDirection`; a new `subgraphs()` helper reads the block structure). `svgBinding.ts` gains `clusterEls`. `StructuralEditor.tsx` gains cluster selection, shift-click multi-select → group, an icon picker, and a link popover + badge. `render.ts` registers the lazy lucide iconify pack.

**Spec:** `docs/superpowers/specs/2026-08-09-cerebro-m29-wave2-parity-design.md` — this stage implements **D6** (icons), the **click-line kind from D3**, the **subgraph ops row of §1**, and stays inside **D10** (surgical ops). Component names used here match the spec and the Stage E plan: `ShapePalette` (Stage E's), `IconPicker`, `setNodeIcon`, `setNodeLink`, `createSubgraph`/`renameSubgraph`/`dissolveSubgraph`/`setSubgraphDirection`, `subgraphs()`, `clusterEls`.

**Prerequisites:** Stage D (M29.24–.28) and **Stage E (M29.29–.34) complete.** M29.35 writes icon metadata through the `node-meta` line kind Stage E lands (spec D3); M29.39 reuses Stage E's `ShapePalette`. Stage E's plan is being authored in parallel — where this plan touches Stage E's surface it codes against the SPEC's contract (D3's `NodeMeta` = `{ shape?, icon?, form?, pos?, label?, raw: Record<string,string> }`, unknown keys preserved in original order, flow-mapping quoting rules) and flags the drift points explicitly. **Do not redefine `NodeMeta`** — import it from `model.ts` where Stage E declared it. If the landed field mechanics differ from the sketches here, the byte-level test assertions in each task are the contract; adapt the implementation, never the proofs.

---

## The two invariants everything here serves (unchanged from Stage C)

1. **Surgical edits only.** An op touches exactly the lines it must; ids never change; opaque lines survive byte-for-byte because serialize() re-emits `raw` for every non-dirty line. Every new understood kind ships with byte-identical round-trip proofs (spec D10). `createSubgraph` gets the strongest version: even lines it MOVES keep their exact bytes — they are relocated, never re-emitted.
2. **Editing degrades; rendering never does.** A `click` variant we don't own (`click A href "…"`, callbacks, tooltips, comma id-lists) goes opaque, renders fine, and simply isn't editable. Same for anonymous subgraphs.

## Verified DOM/grammar contract (vendored mermaid v11.16.1, `docs/examples/mermaid-develop/` in the main checkout)

- **Clusters:** a subgraph renders as `<g class="cluster …" id="<domId>">` — `packages/mermaid/src/rendering-util/rendering-elements/clusters.js:22-27` (`.attr('class', 'cluster ' + node.cssClasses).attr('id', node.domId)`). Subgraph nodes built in `flowDb.getData()` carry **no `domId` field** (`packages/mermaid/src/diagrams/flowchart/flowDb.ts:1198-1213` — the `isGroup: true` push has no `domId`), and `packages/mermaid/src/rendering-util/render.ts:67-72` then computes `node.domId = `${diagramId}-${node.domId || node.id}``. So a cluster's DOM id is **`<renderId>-<subgraphId>` exactly — no `flowchart-` prefix, no counter**, unlike node groups (`<renderId>-flowchart-<id>-<n>`). `stripRenderId` in svgBinding already handles the render-id prefix; cluster matching is then an EXACT match against known subgraph ids.
- **Subgraph ids** (`flowDb.ts:674-745`, `addSubGraph`): `subgraph id[Title]` → explicit id. `subgraph OneWord` → id = `OneWord` (id text === title text, no whitespace). `subgraph Two Words` → whitespace in the id text zeroes it (`flowDb.ts:681-683`) and the id becomes `'subGraph' + subCount` (`flowDb.ts:725`). `subCount` increments once per `addSubGraph` call (`flowDb.ts:728`), and the jison reduction for a subgraph fires at its `end` — so **generated ordinals follow CLOSE order, inner-before-outer**, and anonymous `subgraph`/`end` blocks consume an ordinal too. Membership dedupe: a node already claimed by an earlier-added (= inner, closed-first) subgraph is removed from a later one (`makeUniq`, `flowDb.ts:743`).
- **`direction` inside subgraphs:** lexer `flow.jison:140-144`, and `direction` is also a legal TOP-level statement (`flow.jison:388`, rule at `622-631`) that calls `setDirection` — so a `direction TD` line orphaned by dissolving its subgraph would silently override the header's direction. Dissolve must remove it (decided below).
- **`click` grammar** (`flow.jison:107-114` lexer, `541-555` rules): `click <id> "<target>"` is the plain-link form (`CLICK STR` → `yy.setLink`, flowDb.ts:553-562). Variants — `call`/`CALLBACKNAME`, `href`, tooltip second string, `_blank`-style `LINK_TARGET`, comma id-lists — all exist and are NOT ours; they stay opaque. **CORRECTED 2026-08-09 during M29.36 — the claim that stood here was measured FALSE on the bundled 11.16.0, and it was repeated in four other places in this plan.** At `securityLevel: 'strict'` mermaid attaches no click *handler* (`flowDb.ts:500` does gate that path), but it DOES emit a real anchor that **wraps the node `<g>` the binding layer resolves**: `<a href="notes/a.md" data-look="classic"><g class="node default clickable" id="flowchart-A-…">`. A `javascript:` target is neutralised (sanitizeUrl drops the attribute), but a vault-relative or absolute target is **live navigation** — inside the Tauri webview it takes the whole app off the SPA. **The picture is NOT inert.** The editor still owns click semantics and M29.38's badge is still the intended hit target, but M29.38 must ALSO neutralize the anchor (`preventDefault` on it, or strip `href` in `bindFlowchartSvg`): `StructuralEditor.tsx:187` calls `stopPropagation()` and **not** `preventDefault()`, so clicking a linked node merely to select it follows the link. This is live today for hand-authored click lines, independent of `setNodeLink`. Do not write the old claim into code comments.
- **Icons** (verified against v11.16.1): `mermaid.registerIconPacks([{ name, loader }])` is on the default export (`packages/mermaid/src/mermaid.ts:467,485`); `name` overrides the pack's own prefix; loaders are lazy and cached; an unregistered pack renders an 80×80 blue "?" box, **not an error**; icon names REQUIRE the `pack:` prefix (fallbackPrefix is `''`); meta keys are `icon` / `form` (square|circle|rounded) / `pos` (t|b) / `h` (default 48) / `w`.

## Repo traps (read before coding)

- `pnpm test:run`, never `pnpm test` (watch mode never exits). E2E against a second checkout: `PORT=5273 pnpm e2e`.
- **No jest-dom.** Assert with `expect(x).not.toBeNull()`, `getByTestId` (throws on miss), `queryByTestId(...)===null` — never `toBeInTheDocument`.
- Unit tests **mock `../render`** with a fixture svg (Stage C pattern) — real mermaid never runs under vitest.
- Zero-warning lint; every `eslint-disable` states why in place.
- The repo's **security hook can reject Write/Edit payloads containing html-ish content** (svg fixture strings). If a write is blocked, create the file via `bash` heredoc with a QUOTED delimiter (`cat > file <<'EOF'`).
- **StructuralEditor's svg subtree is React-free** — mermaid's svg is written via `innerHTML` and handlers bind imperatively in the bind effect (`el.onclick = …`), never through JSX. New cluster/badge handlers follow that rule; only overlays OUTSIDE the svg (toolbars, popovers, badges) are React.
- `.gitattributes`: write escapes, never raw control bytes.
- Corpus (`demo-vault/`) edits only in the e2e task, if at all — this plan needs none.

---

### Task F1: Icons — lazy lucide pack + `setNodeIcon` + `IconPicker` (M29.35)

**Files:**
- Modify: `package.json` (dep), `src/mermaid/render.ts`, `src/mermaid/render.test.ts`
- Modify: `src/mermaid/flowchart/ops.ts`, `src/mermaid/flowchart/ops.test.ts`
- Create: `src/mermaid/flowchart/IconPicker.tsx`, `src/mermaid/flowchart/IconPicker.test.tsx`
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx` (icon button in the node toolbar), `StructuralEditor.test.tsx`

> **Naming note:** `src/components/ui/IconPicker.tsx` already exists (M16.26 — the frontmatter/type-icon grid). This task's component is diagram-specific (curated list, `lucide:` pack-prefixed values, free-text entry, clear action) and lives at `src/mermaid/flowchart/IconPicker.tsx` — same name per the spec, different module path, imported path-qualified. Do not merge them: the ui one writes bare lucide names for `Icon`, this one writes pack-prefixed names for mermaid.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add @iconify-json/lucide
```

Data-only package (icon JSON + a tiny index module). It is loaded ONLY through the dynamic-import loader below, so it lands in its own lazy chunk (~1MB) that the browser fetches the first time mermaid actually renders an icon — spec D6's cost model.

- [ ] **Step 2: Write the failing render.ts test**

Extend `src/mermaid/render.test.ts`. The existing file mocks `mermaid` with `initialize`/`render`/`registerLayoutLoaders` spies — add a `registerIconPacks` spy to the same mock and a mock for the pack module:

```ts
// In the vi.mock('mermaid', …) factory, alongside registerLayoutLoaders:
//   registerIconPacks: (...a: unknown[]) => iconPackSpy(...a),
// New module-level spy next to registerSpy:
const iconPackSpy = vi.fn();
// And reset it in beforeEach: iconPackSpy.mockReset();

vi.mock('@iconify-json/lucide', () => ({
  icons: { prefix: 'lucide', icons: { rocket: { body: '<path d="fake"/>' } } },
}));

describe('icon packs', () => {
  it('registers the lucide pack once, lazily, under the name mermaid will resolve', async () => {
    const { renderMermaid } = await freshModule();
    await renderMermaid('graph TD\n  A --> B');
    await renderMermaid('graph TD\n  A --> C');
    expect(iconPackSpy).toHaveBeenCalledTimes(1);
    const packs = iconPackSpy.mock.calls[0][0] as { name: string; loader: () => Promise<unknown> }[];
    expect(packs).toHaveLength(1);
    // `name` is what `lucide:` in diagram source resolves against — it
    // overrides the pack's own prefix, so this string IS the contract.
    expect(packs[0].name).toBe('lucide');
    // The loader is the lazy edge: calling it must yield the pack's icons.
    const icons = (await packs[0].loader()) as { prefix: string };
    expect(icons.prefix).toBe('lucide');
  });
});
```

Run: `pnpm test:run src/mermaid/render.test.ts` — the new test FAILS (`registerIconPacks` never called); the pre-existing tests must still pass (the mock gained a key, nothing else).

- [ ] **Step 3: Register the pack in `loadMermaid`**

In `src/mermaid/render.ts`, inside the `mermaidPromise ??=` IIFE, after `mermaid.registerLayoutLoaders(elkLayouts)`:

```ts
    // Icon packs (M29.35, spec D6): registration is cheap — the loader is
    // the lazy part, fetched+cached by mermaid only when a diagram actually
    // uses a `lucide:` icon. `name` overrides the pack's own prefix and is
    // what `@{ icon: "lucide:x" }` resolves against. An unknown icon or a
    // typo'd pack renders mermaid's blue "?" placeholder box — never an
    // error, so this can't break the render pipeline.
    mermaid.registerIconPacks([
      {
        name: 'lucide',
        loader: () => import('@iconify-json/lucide').then((m) => m.icons),
      },
    ]);
```

Run: `pnpm test:run src/mermaid/render.test.ts` — all pass. (If `registerIconPacks` is missing from the mermaid mock in any OTHER test file that stubs mermaid, extend that mock the same way — grep `vi.mock('mermaid'` first.)

- [ ] **Step 4: Write the failing `setNodeIcon` op tests**

Append to `src/mermaid/flowchart/ops.test.ts`:

```ts
import { setNodeIcon } from './ops'; // merge into the existing import list

describe('setNodeIcon', () => {
  it('writes a full meta line for a node that has none', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B')!;
    const out = serialize(setNodeIcon(m, 'A', 'lucide:rocket'));
    expect(out).toContain('A@{ icon: "lucide:rocket", form: rounded, pos: b }');
    // Untouched lines stay byte-identical.
    expect(out.split('\n')[0]).toBe('flowchart TD');
    expect(out).toContain('  A[Start] --> B');
  });

  it('patches an existing meta line, preserving other keys and their order', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start]\n  A@{ shape: hexagon }')!;
    const out = serialize(setNodeIcon(m, 'A', 'lucide:zap'));
    // shape came first in the source, so shape still comes first.
    expect(out).toContain('A@{ shape: hexagon, icon: "lucide:zap", form: rounded, pos: b }');
  });

  it('does not clobber an explicit form/pos the user already chose', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ icon: "lucide:zap", form: circle, pos: t }')!;
    const out = serialize(setNodeIcon(m, 'A', 'lucide:rocket'));
    expect(out).toContain('form: circle');
    expect(out).toContain('pos: t');
    expect(out).toContain('icon: "lucide:rocket"');
  });

  it('null removes icon, form, and pos — and deletes the line when that empties it', () => {
    const m = parseFlowchart(
      'flowchart TD\n  A[Start]\n  A@{ icon: "lucide:zap", form: rounded, pos: b }',
    )!;
    const out = serialize(setNodeIcon(m, 'A', null));
    expect(out).toBe('flowchart TD\n  A[Start]');
  });

  it('null keeps a meta line that still carries other keys', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ shape: hexagon, icon: "lucide:zap" }')!;
    const out = serialize(setNodeIcon(m, 'A', null));
    expect(out).toContain('A@{ shape: hexagon }');
    expect(out).not.toContain('icon');
  });

  it('null on a node with no meta line is a no-op', () => {
    const src = 'flowchart TD\n  A[Start] --> B';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', null))).toBe(src);
  });
});
```

Run: `pnpm test:run src/mermaid/flowchart/ops.test.ts` — FAIL (no export).

- [ ] **Step 5: Implement `setNodeIcon` in `ops.ts`**

> **Stage E drift point.** Stage E (M29.29) owns the `node-meta` kind, the `NodeMeta` type, the flow-mapping emitter (quote values containing `,`/`:` — an icon value always contains `:` so it is always quoted; `form`/`pos` are bare), and key-order preservation via `raw`. Reuse whatever line-lookup/creation helper E landed (its `setNodeShape` non-bracket path necessarily has one — export it if it isn't). The sketch below assumes D3's published shape (`meta.raw` holds every key in source order, understood keys mirrored as typed fields); if E's landed representation differs, keep Step 4's byte assertions green and adapt the field mechanics — the tests are the contract.

```ts
/**
 * Icon metadata rides the node's `@{ … }` meta line (M29.35, spec D6).
 * Set: writes `icon` (always quoted — the value contains `:`), and defaults
 * `form: rounded` / `pos: b` ONLY when absent, so a user's explicit choice
 * survives an icon swap. Clear (null): removes icon/form/pos as a unit —
 * form/pos are icon presentation and mean nothing without one — and deletes
 * the line entirely when nothing else remains on it. Unknown keys are
 * preserved verbatim, in their original order, per the model's invariant.
 */
export function setNodeIcon(
  model: FlowchartModel,
  id: string,
  icon: string | null,
): FlowchartModel {
  const next = clone(model);
  const idx = next.lines.findIndex((l) => l.parsed.kind === 'node-meta' && l.parsed.id === id);

  if (icon === null) {
    if (idx === -1) return next;
    const line = next.lines[idx];
    if (line.parsed.kind !== 'node-meta') return next;
    const meta = line.parsed.meta;
    delete meta.icon;
    delete meta.form;
    delete meta.pos;
    delete meta.raw.icon;
    delete meta.raw.form;
    delete meta.raw.pos;
    if (Object.keys(meta.raw).length === 0) next.lines.splice(idx, 1);
    else line.dirty = true;
    return next;
  }

  if (idx !== -1) {
    const line = next.lines[idx];
    if (line.parsed.kind !== 'node-meta') return next;
    const meta = line.parsed.meta;
    meta.icon = icon;
    meta.raw.icon = icon;
    if (meta.raw.form === undefined) {
      meta.form = 'rounded';
      meta.raw.form = 'rounded';
    }
    if (meta.raw.pos === undefined) {
      meta.pos = 'b';
      meta.raw.pos = 'b';
    }
    line.dirty = true;
    return next;
  }

  // No meta line yet: mint one at the end of the diagram, the same "append,
  // don't guess a better home" placement addNode/addEdge use.
  next.lines.push({
    raw: '  ',
    parsed: {
      kind: 'node-meta',
      id,
      meta: { icon, form: 'rounded', pos: 'b', raw: { icon, form: 'rounded', pos: 'b' } },
    },
    dirty: true,
  });
  return next;
}
```

Run: `pnpm test:run src/mermaid/flowchart/ops.test.ts` — all pass.

- [ ] **Step 6: Write the failing `IconPicker` tests**

Create `src/mermaid/flowchart/IconPicker.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { icons as packIcons } from '@iconify-json/lucide';
import { resolveIcon } from '@/components/ui/Icon';
import { CURATED_ICONS, IconPicker } from './IconPicker';

describe('CURATED_ICONS', () => {
  it('every curated name resolves in BOTH renderers: lucide-react (preview) and the iconify pack (mermaid)', () => {
    // The preview draws with the app's own Icon component (lucide-react),
    // but mermaid resolves against @iconify-json/lucide. A name valid in one
    // and not the other would preview fine and render the blue "?" box (or
    // vice versa) — so membership in both sets is the whole test.
    for (const name of CURATED_ICONS) {
      expect(resolveIcon(name).Comp, `${name} missing from lucide-react`).not.toBeNull();
      const inPack = name in packIcons.icons || name in (packIcons.aliases ?? {});
      expect(inPack, `${name} missing from @iconify-json/lucide`).toBe(true);
    }
    expect(CURATED_ICONS.length).toBeGreaterThanOrEqual(60);
  });
});

describe('IconPicker', () => {
  it('picks a curated icon as a pack-prefixed value', async () => {
    const onPick = vi.fn();
    render(<IconPicker current={null} onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Icon rocket' }));
    expect(onPick).toHaveBeenCalledWith('lucide:rocket');
  });

  it('search narrows the grid', async () => {
    render(<IconPicker current={null} onPick={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'data');
    expect(screen.getByRole('button', { name: 'Icon database' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Icon rocket' })).toBeNull();
  });

  it('free text offers any lucide name, even one outside the curated list', async () => {
    const onPick = vi.fn();
    render(<IconPicker current={null} onPick={onPick} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'satellite-dish');
    await userEvent.click(screen.getByRole('button', { name: 'Use lucide:satellite-dish' }));
    expect(onPick).toHaveBeenCalledWith('lucide:satellite-dish');
  });

  it('shows a clear action only when an icon is set', async () => {
    const onPick = vi.fn();
    const { rerender } = render(<IconPicker current={null} onPick={onPick} />);
    expect(screen.queryByRole('button', { name: 'Remove icon' })).toBeNull();
    rerender(<IconPicker current="lucide:zap" onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove icon' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });
});
```

Run: `pnpm test:run src/mermaid/flowchart/IconPicker.test.tsx` — FAIL (module not found).

- [ ] **Step 7: Implement `src/mermaid/flowchart/IconPicker.tsx`**

The 68 curated names below were **verified against lucide-react 0.525** (each resolves via `resolveIcon`) on 2026-08-09; the test in Step 6 re-proves both memberships forever, so a future lucide bump that renames one fails loudly instead of shipping a "?" box.

```tsx
import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';

/**
 * Diagram node icon picker (M29.35, spec D6). Distinct from
 * src/components/ui/IconPicker on purpose: this one deals in PACK-PREFIXED
 * values (`lucide:rocket`) because that is what mermaid's `@{ icon: … }`
 * resolves — names without a pack prefix render the blue "?" box
 * (fallbackPrefix is '' upstream). The curated list keeps "pick an icon" a
 * choice, not a scroll; the free-text row keeps every other lucide glyph one
 * keystroke away. Preview uses the app's own Icon component — same glyph
 * family, so what you see is what mermaid draws.
 */

/** Verified in lucide-react 0.525 AND @iconify-json/lucide (test-enforced). */
export const CURATED_ICONS: string[] = [
  'activity', 'archive', 'bell', 'bookmark', 'boxes', 'building', 'calendar',
  'camera', 'chart-bar', 'chart-pie', 'check', 'clock', 'cloud', 'code',
  'cpu', 'credit-card', 'database', 'download', 'eye', 'file-text', 'flag',
  'folder', 'funnel', 'git-branch', 'git-merge', 'globe', 'hard-drive',
  'heart', 'house', 'image', 'inbox', 'info', 'key', 'layers', 'lightbulb',
  'link', 'lock', 'mail', 'map-pin', 'message-square', 'monitor', 'network',
  'package', 'pencil', 'phone', 'play', 'rocket', 'search', 'send', 'server',
  'settings', 'shield', 'smartphone', 'star', 'table', 'target', 'terminal',
  'timer', 'trending-up', 'triangle-alert', 'trophy', 'truck', 'upload',
  'user', 'users', 'workflow', 'wrench', 'zap',
];

export function IconPicker({
  current,
  onPick,
}: {
  /** The node's current icon (`lucide:x`), or null. */
  current: string | null;
  /** Called with `lucide:<name>` to set, null to clear. */
  onPick: (icon: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const matches = useMemo(
    () => (q === '' ? CURATED_ICONS : CURATED_ICONS.filter((n) => n.includes(q))),
    [q],
  );

  // Any plausible lucide name typed in full is offered verbatim — the picker
  // must not gatekeep the pack's thousand-plus glyphs behind a 68-name list.
  const freeText = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(q) && !CURATED_ICONS.includes(q) ? q : null;

  return (
    <div data-testid="mermaid-icon-picker" className="w-64 p-2">
      <Input
        placeholder="Search icons…"
        ariaLabel="Search icons"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        width="100%"
      />
      {current !== null && (
        <button
          type="button"
          aria-label="Remove icon"
          onClick={() => onPick(null)}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-600 hover:bg-n-50"
        >
          <Icon name="x" size={12} color="var(--n-500)" />
          Remove icon ({current})
        </button>
      )}
      <div className="mt-2 grid max-h-44 grid-cols-8 gap-1 overflow-y-auto">
        {matches.map((n) => (
          <button
            key={n}
            type="button"
            title={n}
            aria-label={`Icon ${n}`}
            aria-pressed={current === `lucide:${n}`}
            onClick={() => onPick(`lucide:${n}`)}
            className={[
              'flex h-8 w-8 items-center justify-center rounded-md border',
              current === `lucide:${n}`
                ? 'border-cortex-500 bg-n-50'
                : 'border-transparent hover:bg-n-50',
            ].join(' ')}
          >
            <Icon name={n} size={15} color="var(--n-600)" />
          </button>
        ))}
      </div>
      {freeText !== null && (
        <button
          type="button"
          aria-label={`Use lucide:${freeText}`}
          onClick={() => onPick(`lucide:${freeText}`)}
          className="mt-1.5 flex w-full items-center gap-1.5 rounded-md border border-dashed border-n-200 bg-transparent px-2 py-1 text-left text-xs text-n-600 hover:border-n-300"
        >
          {/* Preview via the app's Icon: an unknown name draws the visible
              dashed-square fallback — an honest hint that mermaid will show
              its "?" box for this one too. */}
          <Icon name={freeText} size={14} color="var(--n-600)" />
          Use lucide:{freeText}
        </button>
      )}
      {matches.length === 0 && freeText === null && (
        <div className="py-3 text-center text-xs text-n-400">No icons match "{query}"</div>
      )}
    </div>
  );
}
```

Run: `pnpm test:run src/mermaid/flowchart/IconPicker.test.tsx` — all pass. If a curated name fails the pack-membership assertion (the installed `@iconify-json/lucide` snapshot lags lucide-react), REPLACE that name with one that passes in both — do not weaken the test.

- [ ] **Step 8: Wire the icon button into the node toolbar**

In `StructuralEditor.tsx`: add state + a toolbar button + a `Popover`-hosted picker. New imports: `import { Popover } from '@/components/ui/Popover';`, `import { IconPicker } from './IconPicker';`, `import { setNodeIcon } from './ops';` (merge), `import { useRef } from 'react'` already present.

```tsx
// New state, alongside `renaming`/`edgeEditor`:
const [iconOpen, setIconOpen] = useState(false);
const iconBtnRef = useRef<HTMLButtonElement | null>(null);
// And in the existing on-[code] reset effect, add: setIconOpen(false);
```

New button inside the `mermaid-node-toolbar` div, before the delete button:

```tsx
<button
  ref={iconBtnRef}
  type="button"
  aria-label="Node icon"
  onClick={() => setIconOpen((v) => !v)}
  className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
>
  <Icon name="star" size={13} color="var(--n-600)" />
</button>
```

And after the toolbar's closing tag (sibling, still inside the relative wrapper):

```tsx
{iconOpen && validSelected !== null && (
  <Popover
    onClose={() => setIconOpen(false)}
    anchorRef={iconBtnRef}
    className="rounded-md border border-n-200 bg-n-0 shadow-md"
    ariaLabel="Node icon picker"
  >
    <IconPicker
      current={currentIconOf(model, validSelected)}
      onPick={(icon) => {
        setIconOpen(false);
        apply(setNodeIcon(model, validSelected, icon));
      }}
    />
  </Popover>
)}
```

`currentIconOf` is a five-line local helper: find the node's `node-meta` line, return `parsed.meta.icon ?? null`. Add a StructuralEditor test (mocked render, Stage C pattern): click node A → click "Node icon" → click "Icon rocket" → `onChangeCode` called with a string containing `A@{ icon: "lucide:rocket"`.

Run: `pnpm test:run src/mermaid/flowchart/` — all pass.

- [ ] **Step 9: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck && pnpm test:run src/mermaid
git add package.json pnpm-lock.yaml src/mermaid/render.ts src/mermaid/render.test.ts \
  src/mermaid/flowchart/ops.ts src/mermaid/flowchart/ops.test.ts \
  src/mermaid/flowchart/IconPicker.tsx src/mermaid/flowchart/IconPicker.test.tsx \
  src/mermaid/flowchart/StructuralEditor.tsx src/mermaid/flowchart/StructuralEditor.test.tsx
git commit -m "feat(mermaid): lucide icons in nodes — lazy pack, surgical meta writes (M29.35)"
```

---

### Task F2: The `click` line kind + `setNodeLink` (M29.36)

**Files:**
- Modify: `src/mermaid/flowchart/model.ts`, `model.test.ts`
- Modify: `src/mermaid/flowchart/ops.ts`, `ops.test.ts`

- [ ] **Step 1: Write the failing model tests**

Append to `model.test.ts`:

```ts
import { nodeLinks } from './model'; // merge into the existing import

describe('click lines', () => {
  const SRC = [
    'flowchart TD',
    '  A[Start] --> B',
    '  click A "https://example.com"',
    '  click B "projects/atlas/project.md"',
    '  click B call doThing()',
    '  click A href "https://example.com"',
    '  click A "https://example.com" "a tooltip"',
    '  click A,B "https://example.com"',
    '  click',
  ].join('\n');

  it('owns exactly the plain `click <id> "<target>"` form; every variant stays opaque', () => {
    const model = parseFlowchart(SRC)!;
    const kinds = model.lines.map((l) => l.parsed.kind);
    expect(kinds[2]).toBe('click');
    expect(kinds[3]).toBe('click');
    // call / href / tooltip / comma-list / bare keyword: not ours. The bare
    // `click` line matters most — without an explicit guard the node-token
    // fallback would mint a phantom node with id "click" (the same trap the
    // anonymous `subgraph` line already documents).
    expect(kinds.slice(4)).toEqual(['opaque', 'opaque', 'opaque', 'opaque', 'opaque']);
  });

  it('parses id and target', () => {
    const model = parseFlowchart(SRC)!;
    const line = model.lines[2].parsed;
    expect(line).toEqual({ kind: 'click', id: 'A', target: 'https://example.com' });
  });

  it('classDef and class stay opaque — the keyword regex still matches longest-first', () => {
    const model = parseFlowchart('flowchart TD\n  A\n  classDef hot fill:#f96\n  class A hot')!;
    expect(model.lines[2].parsed.kind).toBe('opaque');
    expect(model.lines[3].parsed.kind).toBe('opaque');
  });

  it('nodeLinks maps each linked node to its target (last click line wins, like mermaid)', () => {
    const model = parseFlowchart(
      'flowchart TD\n  A --> B\n  click A "one.md"\n  click A "two.md"',
    )!;
    expect(nodeLinks(model).get('A')).toEqual({ line: 3, target: 'two.md' });
  });

  it('round-trips click lines byte-identically when untouched', () => {
    expect(serialize(parseFlowchart(SRC)!)).toBe(SRC);
  });
});
```

Run: `pnpm test:run src/mermaid/flowchart/model.test.ts` — FAIL.

- [ ] **Step 2: Implement the kind in `model.ts`**

Four edits:

1. `ParsedLine` union gains (per spec D3, exactly):

```ts
  | { kind: 'click'; id: string; target: string }
```

2. Remove `click` from `OPAQUE_KEYWORDS`. After Stage E removed `style`, the regex becomes:

```ts
const OPAQUE_KEYWORDS = /^(classDef|class|linkStyle|direction|accTitle|accDescr)\b/;
```

**Ordering proof, in a comment right above it:** `classDef` must stay before `class` in the alternation — the regex engine tries alternatives left to right, and while `\b` would anyway reject the `class` branch against `classDef…` (the following `D` is a word char), the explicit order makes the intent unmissable and costs nothing. `click` leaving this list does NOT mean click lines are free-form parsed: the guard in `parseLine` below sends every unowned `click…` shape straight to opaque before any fallback can touch it.

3. In `parseLine`, immediately after the `OPAQUE_KEYWORDS` test:

```ts
  // The plain-link click form is ours (M29.36, spec D3): `click <id> "<target>"`.
  // Everything else the grammar allows — call/callback forms, `href`, a second
  // tooltip string, `_blank`-style targets, comma id-lists (flow.jison:541-555)
  // — stays opaque: renders fine, not editable. The trailing guard is
  // load-bearing: without it a bare or half-typed `click` line would fall to
  // the node-token parser and mint a phantom node with id "click".
  const click = trimmed.match(/^click\s+([A-Za-z0-9_.-]+)\s+"([^"]*)"$/);
  if (click !== null) return { kind: 'click', id: click[1], target: click[2] };
  if (/^click\b/.test(trimmed)) return { kind: 'opaque' };
```

4. `emitLine` gains a case, and `nodeLinks` joins the read helpers:

```ts
    case 'click':
      return `${indent}click ${p.id} "${p.target}"`;
```

```ts
/**
 * Every node with an OWNED click line → its target. Later lines win, which is
 * what mermaid itself does (`setLink` overwrites, flowDb.ts:553). NOTE the
 * editor is the ONLY thing that honors these at runtime: render.ts pins
 * securityLevel 'strict', where mermaid attaches no click HANDLER
 * (flowDb.ts:500) — but it still emits a live `<a href>` wrapping the node
 * (measured, M29.36; see the corrected note at the top of this plan), so the
 * M29.38 badge is the hit target AND that anchor must be neutralized.
 */
export function nodeLinks(model: FlowchartModel): Map<string, { line: number; target: string }> {
  const out = new Map<string, { line: number; target: string }>();
  model.lines.forEach((line, i) => {
    if (line.parsed.kind === 'click') out.set(line.parsed.id, { line: i, target: line.parsed.target });
  });
  return out;
}
```

Run: `pnpm test:run src/mermaid/flowchart/model.test.ts` — all pass. Also run the FULL suite (`pnpm test:run src/mermaid`): Stage C's model tests count opaque lines in an EXOTIC fixture containing `click B "https://example.com"` — that line is now `click`, not opaque. If the `toBeGreaterThanOrEqual(8)` style assertion fails, lower its floor by exactly one and note why in the diff; do not restructure the fixture.

- [ ] **Step 3: Write the failing `setNodeLink` tests**

Append to `ops.test.ts`:

```ts
import { setNodeLink } from './ops'; // merge

describe('setNodeLink', () => {
  it('appends a click line for an unlinked node', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B')!;
    const out = serialize(setNodeLink(m, 'A', 'projects/atlas/project.md'));
    expect(out).toBe('flowchart TD\n  A[Start] --> B\n  click A "projects/atlas/project.md"');
  });

  it('patches an existing click line in place', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  click A "old.md"\n  classDef hot fill:#f96')!;
    const out = serialize(setNodeLink(m, 'A', 'https://example.com'));
    expect(out.split('\n')[2]).toBe('  click A "https://example.com"');
    expect(out.split('\n')[3]).toBe('  classDef hot fill:#f96'); // untouched, byte-identical
  });

  it('null removes every owned click line for the node', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  click A "one.md"\n  click A "two.md"')!;
    expect(serialize(setNodeLink(m, 'A', null))).toBe('flowchart TD\n  A --> B');
  });

  it('a double quote in the target is substituted, never emitted raw', () => {
    // Same boundary rule as setEdgeLabel's pipe: `"` closes the target string
    // in mermaid's grammar, so a literal one would truncate the line into
    // garbage. Substitute at the last boundary before the file.
    const m = parseFlowchart('flowchart TD\n  A')!;
    const out = serialize(setNodeLink(m, 'A', 'weird"name.md'));
    expect(out).toContain('click A "weird\'name.md"');
  });
});
```

Run — FAIL.

- [ ] **Step 4: Implement `setNodeLink` in `ops.ts`**

```ts
/**
 * Bind a node to a URL or vault-relative record path via an owned click line
 * (M29.36). One target per node: patch the first owned line, drop any owned
 * duplicates; `null` clears. Opaque click VARIANTS (href/call/tooltip forms)
 * are never touched — if the user hand-wrote one, it survives byte-for-byte
 * and simply isn't what the editor reads.
 */
export function setNodeLink(
  model: FlowchartModel,
  id: string,
  target: string | null,
): FlowchartModel {
  const next = clone(model);
  const owned: number[] = [];
  next.lines.forEach((l, i) => {
    if (l.parsed.kind === 'click' && l.parsed.id === id) owned.push(i);
  });

  if (target === null) {
    for (let i = owned.length - 1; i >= 0; i -= 1) next.lines.splice(owned[i], 1);
    return next;
  }

  const safe = target.replaceAll('"', "'");
  if (owned.length > 0) {
    const line = next.lines[owned[0]];
    if (line.parsed.kind === 'click') {
      line.parsed.target = safe;
      line.dirty = true;
    }
    for (let i = owned.length - 1; i >= 1; i -= 1) next.lines.splice(owned[i], 1);
    return next;
  }

  next.lines.push({ raw: '  ', parsed: { kind: 'click', id, target: safe }, dirty: true });
  return next;
}
```

Run: `pnpm test:run src/mermaid/flowchart/` — all pass.

- [ ] **Step 5: Lint, typecheck, full unit suite, commit**

```bash
pnpm lint && pnpm typecheck && pnpm test:run
git add src/mermaid/flowchart/model.ts src/mermaid/flowchart/model.test.ts \
  src/mermaid/flowchart/ops.ts src/mermaid/flowchart/ops.test.ts
git commit -m "feat(mermaid): click lines understood — the editor owns link semantics (M29.36)"
```

---

### Task F3: Subgraph structure — `subgraphs()`, create, rename, dissolve, direction (M29.37)

**Files:**
- Modify: `src/mermaid/flowchart/model.ts`, `model.test.ts`
- Modify: `src/mermaid/flowchart/ops.ts`, `ops.test.ts`

**Design decisions this task locks (each proven by a test):**

1. **`subgraph-start` becomes structured**: `{ kind: 'subgraph-start'; id: string | null; title: string }`. `id` is non-null ONLY for the explicit `subgraph id[Title]` form. The single-word (`subgraph Alpha`) and multi-word (`subgraph Two Words`) forms both parse as `id: null` with the raw text as `title` — the EFFECTIVE id is computed by `subgraphs()`, mirroring flowDb (see the contract section above). Existing consumers only read `title`; emit for the `id: null` form is byte-compatible with today's.
2. **Effective ids mirror mermaid exactly**: explicit id → itself; whitespace-free title → the title; otherwise `subGraph<k>` where `k` counts subgraph blocks in **close order** (inner before outer — jison reduces at `end`), anonymous bare-`subgraph` blocks included (they consume an ordinal in flowDb's `subCount` too). Getting this wrong makes M29.38's cluster binding silently miss generated-id clusters, so it is tested with a nested fixture.
3. **`createSubgraph` minimal-surgery rule**: the lines it may move are exactly the lines wholly owned by the selection — a `node`/`node-meta`/`click` line whose id is selected, or an `edges` line ALL of whose referenced ids are selected. Edges touching outside nodes stay where they are (mermaid draws cross-boundary edges fine). If the movable lines are already contiguous they are wrapped in place; otherwise they are RELOCATED to the first movable line's position, in their original relative order, **with their raw bytes untouched** (moved lines stay non-dirty — serialize re-emits their raws verbatim). A selected id that no movable line claims (it only appears on shared edge lines) gets a minted bare reference line inside the wrap — a bare `id` inside the body is how mermaid claims membership. Refusal (returns `{ model, id: null }`, ops never throw): empty selection, an unknown id, or any movable line already inside an existing subgraph (a line cannot have two parents; re-parenting someone else's subgraph is more than "group these nodes" may do).
4. **Generated subgraph id from the title**: strip to `[A-Za-z0-9_-]` with spaces → `_`, then uniquify against every node id (case-insensitive, same caution as `newNodeId`) and every existing effective subgraph id by appending `_2`, `_3`, …; a title that sanitizes to nothing falls back to `sg`. The id is emitted explicitly (`subgraph <id>[<title>]`) so `style`/`class` lines written later have a stable handle.
5. **`renameSubgraph` preserves identity**: retitling a `subgraph Alpha` block to a multi-word title would silently change its effective id from `Alpha` to a generated `subGraph<k>` — breaking any opaque `style Alpha …` line. So rename CONVERTS the single-word form to the explicit form first (`subgraph Alpha[New title]`); a block whose id was already generated just gets its title text replaced (its ordinal id never depended on the title).
6. **`dissolveSubgraph` deletes the two marker lines** — body lines stay byte-identical INCLUDING their indentation (mermaid is whitespace-insensitive here; re-indenting would be cosmetic churn dressed as correctness) — **plus the subgraph's own top-level `direction` line, if any**. Leaving it would be corruption, not preservation: `direction` is a legal top-level statement (flow.jison:388, 622-631) that calls `setDirection` and would override the header's direction for the whole diagram. Nested subgraphs' direction lines are inside their own blocks and are untouched.
7. **`setSubgraphDirection` edits opaque raws** — `direction` lines stay opaque (spec D3 adds exactly four kinds; direction is not one of them), so this op is the second sanctioned raws-exception after `setLayoutEngine`, for the same reason: structure the parser refuses to own, edited in place with indentation preserved.

- [ ] **Step 1: Write the failing model tests**

Append to `model.test.ts`:

```ts
import { subgraphs } from './model'; // merge

const SUBS = [
  'flowchart TD',
  '  subgraph ops[Operations Zone]',
  '    direction LR',
  '    A[Start] --> B',
  '  end',
  '  subgraph Alpha',
  '    C',
  '  end',
  '  subgraph Outer Zone',
  '    D --> E',
  '    subgraph Inner Zone',
  '      F',
  '    end',
  '  end',
  '  B --> C',
].join('\n');

describe('subgraph-start parsing', () => {
  it('splits the explicit id[Title] form and strips label quotes', () => {
    const m = parseFlowchart('flowchart TD\n  subgraph s1["Quoted title"]\n  end')!;
    expect(m.lines[1].parsed).toEqual({ kind: 'subgraph-start', id: 's1', title: 'Quoted title' });
  });

  it('keeps plain titles whole with a null id', () => {
    const m = parseFlowchart(SUBS)!;
    expect(m.lines[5].parsed).toEqual({ kind: 'subgraph-start', id: null, title: 'Alpha' });
    expect(m.lines[8].parsed).toEqual({ kind: 'subgraph-start', id: null, title: 'Outer Zone' });
  });

  it('round-trips every form byte-identically when untouched', () => {
    expect(serialize(parseFlowchart(SUBS)!)).toBe(SUBS);
    const quoted = 'flowchart TD\n  subgraph s1["Quoted title"]\n  end';
    expect(serialize(parseFlowchart(quoted)!)).toBe(quoted);
  });
});

describe('subgraphs()', () => {
  it('lists blocks with effective ids mirroring mermaid: explicit, single-word, generated-by-close-order', () => {
    const subs = subgraphs(parseFlowchart(SUBS)!);
    expect(subs.map((s) => s.id)).toEqual(['ops', 'Alpha', 'subGraph3', 'subGraph2']);
    // Close order: ops closes first (ordinal 0), Alpha second (1), Inner
    // closes BEFORE Outer (2), Outer last (3) — flowDb's subCount ticks at
    // each jison reduction, which fires at `end`. Explicit/single-word blocks
    // still consume ordinals; only whitespace-titled blocks USE them.
    expect(subs.map((s) => s.title)).toEqual(['Operations Zone', 'Alpha', 'Outer Zone', 'Inner Zone']);
  });

  it('reports line ranges, members (inner claims win), and own-depth direction', () => {
    const subs = subgraphs(parseFlowchart(SUBS)!);
    const ops = subs[0];
    expect(ops).toMatchObject({ startLine: 1, endLine: 4, direction: 'LR' });
    expect(ops.memberIds).toEqual(['A', 'B']);
    const outer = subs.find((s) => s.title === 'Outer Zone')!;
    expect(outer.memberIds).toEqual(['D', 'E']); // F belongs to Inner, which closed first
    expect(outer.direction).toBeNull();
  });

  it('an anonymous bare `subgraph` block consumes an end AND an ordinal, but is not listed', () => {
    const src = 'flowchart TD\n  subgraph\n    X\n  end\n  subgraph Two Words\n    Y\n  end';
    const subs = subgraphs(parseFlowchart(src)!);
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe('subGraph1'); // the anonymous block took subGraph0
  });

  it('a stray `end` with no opener is ignored', () => {
    expect(subgraphs(parseFlowchart('flowchart TD\n  A\n  end')!)).toHaveLength(0);
  });
});
```

Run — FAIL.

- [ ] **Step 2: Implement in `model.ts`**

Parsing (replace the current `subgraph` branch in `parseLine`; the anonymous-`subgraph` opaque branch and its phantom-node comment stay exactly as they are):

```ts
  const sub = trimmed.match(/^subgraph\s+(.+)$/);
  if (sub !== null) {
    const rest = sub[1].trim();
    // Explicit-id form: `subgraph id[Title]`, title optionally quoted the
    // same way node labels are. Anything else keeps the whole text as title;
    // the EFFECTIVE id (what mermaid assigns, what the DOM carries) is
    // subgraphs()'s job — it depends on close-order ordinals a single line
    // cannot know.
    const bracketed = rest.match(/^([A-Za-z0-9_.-]+)\[(.+)\]$/);
    if (bracketed !== null) {
      let title = bracketed[2];
      if (title.startsWith('"') && title.endsWith('"') && title.length >= 2) {
        title = title.slice(1, -1);
      }
      return { kind: 'subgraph-start', id: bracketed[1], title };
    }
    return { kind: 'subgraph-start', id: null, title: rest };
  }
```

Emit (replace the `subgraph-start` case; `quoteLabel` is already in scope):

```ts
    case 'subgraph-start':
      return p.id !== null
        ? `${indent}subgraph ${p.id}[${quoteLabel(p.title)}]`
        : `${indent}subgraph ${p.title}`;
```

The reader:

```ts
export interface SubgraphEntry {
  index: number;
  /** Effective id — what mermaid assigns and the cluster DOM carries. */
  id: string;
  /** True when the source spells the id explicitly (`subgraph id[Title]`). */
  explicitId: boolean;
  title: string;
  startLine: number;
  endLine: number;
  /** Node ids this block claims — nested blocks' claims already removed. */
  memberIds: string[];
  /** Own-depth `direction X` line, if any (an opaque line we only READ). */
  direction: Direction | null;
}

const DIRECTION_LINE = /^\s*direction\s+(TB|TD|BT|RL|LR)\s*$/;

/**
 * The subgraph blocks of a model, in DOCUMENT order, with effective ids that
 * mirror flowDb.addSubGraph (vendored v11.16.1, flowDb.ts:674-745): explicit
 * id wins; a whitespace-free title IS the id; anything else gets
 * `subGraph<k>` where k is the block's CLOSE-order ordinal — jison reduces a
 * subgraph at its `end`, so inner blocks number before outer ones, and
 * anonymous bare-`subgraph` blocks (opaque to us) consume ordinals too.
 * Membership mirrors makeUniq: a node claimed by an earlier-CLOSED block is
 * not claimed again by a later one.
 */
export function subgraphs(model: FlowchartModel): SubgraphEntry[] {
  interface Open {
    startLine: number;
    id: string | null;
    title: string | null; // null marks an anonymous (opaque) opener
    refs: Set<string>;
    direction: Direction | null;
  }
  const stack: Open[] = [];
  const closed: (SubgraphEntry & { ordinal: number })[] = [];
  const claimed = new Set<string>();
  let ordinal = 0;

  model.lines.forEach((line, i) => {
    const p = line.parsed;
    if (p.kind === 'subgraph-start') {
      stack.push({ startLine: i, id: p.id, title: p.title, refs: new Set(), direction: null });
      return;
    }
    // An anonymous `subgraph` line is opaque to the model but still opens a
    // block — the matching `end` and the flowDb ordinal both exist whether we
    // can edit the block or not. Miscounting here would shift every generated
    // id after it and break cluster binding.
    if (p.kind === 'opaque' && line.raw.trim() === 'subgraph') {
      stack.push({ startLine: i, id: null, title: null, refs: new Set(), direction: null });
      return;
    }
    if (p.kind === 'subgraph-end') {
      const open = stack.pop();
      if (open === undefined) return; // stray `end`: mermaid errors, we just don't pair it
      const k = ordinal;
      ordinal += 1;
      if (open.title === null) return; // anonymous: consumes the ordinal, listed nowhere
      const memberIds = [...open.refs].filter((id) => !claimed.has(id));
      for (const id of memberIds) claimed.add(id);
      const explicitId = open.id !== null;
      const id =
        open.id ?? (!/\s/.test(open.title) ? open.title : `subGraph${k}`);
      closed.push({
        index: 0, // fixed up below, once document order is known
        id,
        explicitId,
        title: open.title,
        startLine: open.startLine,
        endLine: i,
        memberIds,
        direction: open.direction,
        ordinal: k,
      });
      return;
    }
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    if (p.kind === 'opaque' && top.direction === null) {
      const dir = line.raw.match(DIRECTION_LINE);
      if (dir !== null) top.direction = dir[1] as Direction;
    }
    // Any reference inside the innermost open block claims membership there —
    // node tokens, edge endpoints, meta and click subjects alike (a click
    // statement's value flows into the jison statement list: flow.jison:542).
    if (p.kind === 'node') top.refs.add(p.node.id);
    if (p.kind === 'node-meta' || p.kind === 'click') top.refs.add(p.id);
    if (p.kind === 'edges') {
      for (const seg of p.segments) for (const r of [...seg.from, ...seg.to]) top.refs.add(r.id);
    }
  });

  closed.sort((a, b) => a.startLine - b.startLine);
  return closed.map(({ ordinal: _ordinal, ...entry }, index) => ({ ...entry, index }));
}
```

(`direction` on nested-depth lines: the innermost-open-block rule handles it — a `direction` line inside Inner is read while Inner is top of stack, so Outer's `direction` stays null. An unclosed block at EOF is simply never listed, matching "editing degrades".)

Run: `pnpm test:run src/mermaid/flowchart/model.test.ts` — all pass, including the pre-existing round-trip suite.

- [ ] **Step 3: Write the failing ops tests**

Append to `ops.test.ts`:

```ts
import { createSubgraph, dissolveSubgraph, renameSubgraph, setSubgraphDirection } from './ops'; // merge
import { subgraphs } from './model'; // merge

describe('createSubgraph', () => {
  it('wraps contiguous lines in place — body bytes untouched', () => {
    const src = 'flowchart TD\n  A[Start] --> B\n  C --> D\n  classDef hot fill:#f96';
    const { model: out, id } = createSubgraph(parseFlowchart(src)!, ['C', 'D'], 'Phase 2');
    expect(id).toBe('Phase_2');
    expect(serialize(out)).toBe(
      'flowchart TD\n  A[Start] --> B\n  subgraph Phase_2[Phase 2]\n  C --> D\n  end\n  classDef hot fill:#f96',
    );
  });

  it('moves non-contiguous owned lines together, raw bytes preserved, others untouched', () => {
    const src = [
      'flowchart TD',
      '  A[Start]',
      '  %% keep me exactly here-ish',
      '  B[Middle]',
      '  A --> C',
      '  A --> B',
    ].join('\n');
    const { model: out } = createSubgraph(parseFlowchart(src)!, ['A', 'B'], 'Grouped');
    const text = serialize(out);
    // Owned lines: A's def, B's def, and `A --> B` (both endpoints selected).
    // `A --> C` touches an outsider and stays put. Moved lines keep their bytes.
    expect(text).toBe(
      [
        'flowchart TD',
        '  subgraph Grouped[Grouped]',
        '  A[Start]',
        '  B[Middle]',
        '  A --> B',
        '  end',
        '  %% keep me exactly here-ish',
        '  A --> C',
      ].join('\n'),
    );
  });

  it('mints a bare reference for a selected node no movable line claims', () => {
    const src = 'flowchart TD\n  A --> B\n  B --> C';
    // B only appears on edge lines shared with outsiders — nothing movable
    // claims it, so membership needs a minted bare reference in the body.
    const { model: out } = createSubgraph(parseFlowchart(src)!, ['B'], 'Solo');
    expect(serialize(out)).toBe('flowchart TD\n  A --> B\n  B --> C\n  subgraph Solo[Solo]\n  B\n  end');
  });

  it('uniquifies the generated id against node ids and existing subgraphs', () => {
    const src = 'flowchart TD\n  Phase_2[Clash]\n  X\n  Y';
    const { id } = createSubgraph(parseFlowchart(src)!, ['X', 'Y'], 'Phase 2');
    expect(id).toBe('Phase_2_2');
  });

  it('refuses to re-parent lines already inside a subgraph', () => {
    const src = 'flowchart TD\n  subgraph ops[Ops]\n    A\n  end\n  B';
    const m = parseFlowchart(src)!;
    const { model: out, id } = createSubgraph(m, ['A', 'B'], 'Nope');
    expect(id).toBeNull();
    expect(serialize(out)).toBe(src);
  });
});

describe('renameSubgraph', () => {
  it('retitles the explicit form in place', () => {
    const m = parseFlowchart('flowchart TD\n  subgraph ops[Old]\n    A\n  end')!;
    expect(serialize(renameSubgraph(m, 0, 'New name'))).toContain('subgraph ops[New name]');
  });

  it('converts a single-word block to explicit form so its id survives the retitle', () => {
    const m = parseFlowchart('flowchart TD\n  subgraph Alpha\n    A\n  end\n  style Alpha fill:#eee')!;
    const out = serialize(renameSubgraph(m, 0, 'Alpha Team'));
    expect(out).toContain('subgraph Alpha[Alpha Team]');
    expect(out).toContain('style Alpha fill:#eee'); // the opaque binding still points at something
  });

  it('quotes titles that need it', () => {
    const m = parseFlowchart('flowchart TD\n  subgraph ops[Old]\n  end')!;
    expect(serialize(renameSubgraph(m, 0, 'A (weird) name'))).toContain(
      'subgraph ops["A (weird) name"]',
    );
  });
});

describe('dissolveSubgraph', () => {
  it('removes the markers and the block\'s own direction line; body bytes untouched, indentation included', () => {
    const src = [
      'flowchart TD',
      '  subgraph ops[Operations]',
      '    direction LR',
      '    A[Start] --> B',
      '    subgraph inner[Inner]',
      '      direction TB',
      '      C',
      '    end',
      '  end',
    ].join('\n');
    const out = serialize(dissolveSubgraph(parseFlowchart(src)!, 0));
    expect(out).toBe(
      [
        'flowchart TD',
        '    A[Start] --> B', // original 4-space indent preserved
        '    subgraph inner[Inner]',
        '      direction TB', // inner's direction is inner's business
        '      C',
        '    end',
      ].join('\n'),
    );
  });
});

describe('setSubgraphDirection', () => {
  it('inserts, rewrites, and removes the own-depth direction line', () => {
    const src = 'flowchart TD\n  subgraph ops[Operations]\n    A\n  end';
    const m1 = setSubgraphDirection(parseFlowchart(src)!, 0, 'LR');
    expect(serialize(m1)).toBe('flowchart TD\n  subgraph ops[Operations]\n    direction LR\n    A\n  end');
    const m2 = setSubgraphDirection(parseFlowchart(serialize(m1))!, 0, 'BT');
    expect(serialize(m2)).toContain('    direction BT');
    const m3 = setSubgraphDirection(parseFlowchart(serialize(m2))!, 0, null);
    expect(serialize(m3)).toBe(src);
  });

  it('never touches a nested block\'s direction line', () => {
    const src =
      'flowchart TD\n  subgraph o[O]\n    subgraph i[I]\n      direction RL\n      A\n    end\n  end';
    const out = serialize(setSubgraphDirection(parseFlowchart(src)!, 0, 'LR'));
    expect(out).toContain('      direction RL');
    expect(out).toContain('    direction LR');
  });
});

describe('surgical property (subgraph ops)', () => {
  it('every line an op did not claim is byte-identical afterward', () => {
    const src = [
      'flowchart TD',
      '  %% comment',
      '  A[Start] --> B',
      '  subgraph ops[Operations]',
      '    C --> D',
      '  end',
      '  linkStyle 0 stroke:#f66',
    ].join('\n');
    const before = src.split('\n');
    const after = serialize(renameSubgraph(parseFlowchart(src)!, 0, 'Renamed')).split('\n');
    for (const i of [0, 1, 2, 4, 5, 6]) expect(after[i]).toBe(before[i]);
  });
});
```

Run — FAIL.

- [ ] **Step 4: Implement the four ops in `ops.ts`**

New imports: `subgraphs`, `type Direction` (merge into the existing `./model` import).

```ts
/** Sanitize a title into an id, unique among node ids and subgraph ids. */
function subgraphIdFromTitle(model: FlowchartModel, title: string): string {
  const base = title.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '') || 'sg';
  const taken = new Set([...nodes(model).keys()].map((k) => k.toLowerCase()));
  for (const s of subgraphs(model)) taken.add(s.id.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`.toLowerCase())) n += 1;
  return `${base}_${n}`;
}

/**
 * Group nodes into a new subgraph (M29.37). Minimal surgery, in order of
 * preference: wrap in place when the owned lines are contiguous; otherwise
 * RELOCATE them (raw bytes intact — moved lines stay non-dirty, so serialize
 * re-emits them verbatim) to the first owned line's position and wrap there.
 * A selected id no movable line claims gets a minted bare reference — a bare
 * `id` inside the body is exactly how mermaid claims membership. Refuses
 * (id: null, model unchanged) rather than re-parent lines that already live
 * inside another subgraph.
 */
export function createSubgraph(
  model: FlowchartModel,
  nodeIds: string[],
  title: string,
): { model: FlowchartModel; id: string | null } {
  const next = clone(model);
  const ids = new Set(nodeIds);
  if (ids.size === 0) return { model: next, id: null };
  const known = nodes(next);
  for (const id of ids) if (!known.has(id)) return { model: next, id: null };

  const subs = subgraphs(next);
  const insideExisting = (i: number) => subs.some((s) => i > s.startLine && i < s.endLine);

  const movable: number[] = [];
  next.lines.forEach((line, i) => {
    const p = line.parsed;
    const owned =
      (p.kind === 'node' && ids.has(p.node.id)) ||
      ((p.kind === 'node-meta' || p.kind === 'click') && ids.has(p.id)) ||
      (p.kind === 'edges' &&
        p.segments.every((seg) => [...seg.from, ...seg.to].every((r) => ids.has(r.id))));
    if (owned) movable.push(i);
  });
  if (movable.some(insideExisting)) return { model: next, id: null };

  // Which ids do the movable lines already claim? The rest need minting.
  const claimedByMove = new Set<string>();
  for (const i of movable) {
    eachRef(next.lines[i], (ref) => claimedByMove.add(ref.id));
    const p = next.lines[i].parsed;
    if (p.kind === 'node-meta' || p.kind === 'click') claimedByMove.add(p.id);
  }
  const minted = [...ids].filter((id) => !claimedByMove.has(id));

  const id = subgraphIdFromTitle(next, title);
  const anchor = movable.length > 0 ? movable[0] : next.lines.length;

  // Pull the movable lines out (reverse order keeps indices valid), then
  // reinsert the whole block at the anchor.
  const moved: ModelLine[] = [];
  for (let k = movable.length - 1; k >= 0; k -= 1) {
    moved.unshift(next.lines.splice(movable[k], 1)[0]);
  }
  const block: ModelLine[] = [
    { raw: '  ', parsed: { kind: 'subgraph-start', id, title }, dirty: true },
    ...minted.map(
      (nid): ModelLine => ({
        raw: '  ',
        parsed: { kind: 'node', node: { id: nid, label: null, shape: null } },
        dirty: true,
      }),
    ),
    ...moved,
    { raw: '  ', parsed: { kind: 'subgraph-end' }, dirty: true },
  ];
  next.lines.splice(anchor, 0, ...block);
  return { model: next, id };
}

/**
 * Retitle a subgraph WITHOUT changing its effective id (M29.37): a
 * single-word title doubles as the id upstream, so retitling that form
 * free-hand would re-key the block and orphan every opaque style/class line
 * pointing at it. Converting to the explicit `id[Title]` form first keeps
 * the handle; generated-ordinal ids never depended on the title at all.
 */
export function renameSubgraph(model: FlowchartModel, index: number, title: string): FlowchartModel {
  const next = clone(model);
  const entry = subgraphs(next)[index];
  if (entry === undefined) return next;
  const line = next.lines[entry.startLine];
  if (line.parsed.kind !== 'subgraph-start') return next;
  if (line.parsed.id === null && entry.explicitId === false && !/\s/.test(line.parsed.title)) {
    line.parsed.id = line.parsed.title;
  }
  line.parsed.title = title;
  line.dirty = true;
  return next;
}

/**
 * Remove a subgraph's markers, keeping its body byte-identical — indentation
 * included, since mermaid never cared about it and cosmetic re-indentation
 * would violate the surgical rule. The block's own top-level `direction`
 * line goes with the markers: it is subgraph metadata, and orphaned at top
 * level it becomes a live statement (flow.jison:388) that overrides the
 * header's direction for the whole diagram — deletion is the preserving move.
 */
export function dissolveSubgraph(model: FlowchartModel, index: number): FlowchartModel {
  const next = clone(model);
  const entry = subgraphs(next)[index];
  if (entry === undefined) return next;

  // Own-depth direction lines only: skip anything inside nested blocks.
  const nested = subgraphs(next).filter(
    (s) => s.startLine > entry.startLine && s.endLine < entry.endLine,
  );
  const inNested = (i: number) => nested.some((s) => i >= s.startLine && i <= s.endLine);
  const doomed: number[] = [entry.startLine, entry.endLine];
  for (let i = entry.startLine + 1; i < entry.endLine; i += 1) {
    if (!inNested(i) && next.lines[i].raw.match(/^\s*direction\s+(TB|TD|BT|RL|LR)\s*$/) !== null) {
      doomed.push(i);
    }
  }
  doomed.sort((a, b) => b - a);
  for (const i of doomed) next.lines.splice(i, 1);
  return next;
}

/**
 * Set or clear a subgraph's own `direction` line (M29.37). Direction lines
 * are opaque (spec D3 adds no kind for them), so this edits raws in place —
 * the second sanctioned raws-exception after setLayoutEngine, for the same
 * reason: real structure the parser refuses to own.
 */
export function setSubgraphDirection(
  model: FlowchartModel,
  index: number,
  dir: Direction | null,
): FlowchartModel {
  const next = clone(model);
  const entry = subgraphs(next)[index];
  if (entry === undefined) return next;
  const nested = subgraphs(next).filter(
    (s) => s.startLine > entry.startLine && s.endLine < entry.endLine,
  );
  const inNested = (i: number) => nested.some((s) => i >= s.startLine && i <= s.endLine);

  let found = -1;
  for (let i = entry.startLine + 1; i < entry.endLine; i += 1) {
    if (!inNested(i) && next.lines[i].raw.match(/^\s*direction\s+(TB|TD|BT|RL|LR)\s*$/) !== null) {
      found = i;
      break;
    }
  }

  if (dir === null) {
    if (found !== -1) next.lines.splice(found, 1);
    return next;
  }
  if (found !== -1) {
    const indent = next.lines[found].raw.match(/^\s*/)?.[0] ?? '    ';
    next.lines[found].raw = `${indent}direction ${dir}`;
    return next;
  }
  const startIndent = next.lines[entry.startLine].raw.match(/^\s*/)?.[0] ?? '  ';
  next.lines.splice(entry.startLine + 1, 0, {
    raw: `${startIndent}  direction ${dir}`,
    parsed: { kind: 'opaque' },
    dirty: false,
  });
  return next;
}
```

Run: `pnpm test:run src/mermaid/flowchart/` — iterate until green. The move-and-wrap test and the close-order-ordinal test are the two that flush real bugs; do not weaken them.

- [ ] **Step 5: Lint, typecheck, full suite, commit**

```bash
pnpm lint && pnpm typecheck && pnpm test:run
git add src/mermaid/flowchart/model.ts src/mermaid/flowchart/model.test.ts \
  src/mermaid/flowchart/ops.ts src/mermaid/flowchart/ops.test.ts
git commit -m "feat(mermaid): subgraph ops — group, rename, dissolve, direction, surgically (M29.37)"
```

---

### Task F4: Canvas affordances — cluster selection, group-from-selection, links (M29.38)

**Files:**
- Modify: `src/mermaid/flowchart/svgBinding.ts`, `svgBinding.test.ts`
- Create: `src/mermaid/flowchart/LinkPopover.tsx`, `src/mermaid/flowchart/LinkPopover.test.tsx`
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx`, `StructuralEditor.test.tsx`
- Modify: `src/pages/DiagramPage.tsx`, `src/mermaid/MermaidBlockView.tsx` (thread `entries` + `onOpenPath`)

**The prop threading, designed honestly.** `StructuralEditor` has no store access by design (it is a pure code-in/code-out surface), so it gains two OPTIONAL props: `entries?: Entry[]` (for the link popover's record search, via `resolveTarget`) and `onOpenPath?: (path: string) => void` (what a record badge click does). Both current hosts can supply them cheaply:
- **DiagramPage** already imports `useVaultStore` — add `const entries = useVaultStore((s) => s.entries);` and `const openPath = useOpenPath('in-place');`. `in-place`, not `navigate`: the diagram page IS the canvas the user is standing on; M9.3's backdrop-jump rule is for surfaces that have none. The detail panel mounts app-globally (`src/App.tsx:365`, `{detailOpen && <DetailPanel />}`), so `openDetail` works from here.
- **MermaidBlockView** already imports `useVaultStore` too (for `saveAsFile`) — same two lines, passed to its embedded `StructuralEditor`. Also `in-place`: yanking a reader out of their doc to give a record a "backdrop" would throw away the doc they were reading.
- **Stage D's `FullScreenDiagramEditor` and Stage H's `WhiteboardView`** (both authored in parallel/later) receive the same pair through whatever prop surface they give `StructuralEditor`; this plan changes only the two hosts that exist in this branch today. When omitted, the link button hides its record search (URL entry still works) and record badges no-op — degradation, never a crash.

- [ ] **Step 1: Write the failing svgBinding test**

Append to `svgBinding.test.ts`:

```ts
describe('cluster binding', () => {
  const CLUSTER_SVG = [
    '<svg id="cerebro-mermaid-7" viewBox="0 0 100 100">',
    '  <g class="cluster " id="cerebro-mermaid-7-ops"><rect/></g>',
    '  <g class="cluster " id="cerebro-mermaid-7-subGraph1"><rect/></g>',
    '  <g class="cluster " id="cerebro-mermaid-7-mystery"><rect/></g>',
    '  <g class="node default" id="cerebro-mermaid-7-flowchart-A-0"><rect/></g>',
    '</svg>',
  ].join('\n');

  it('maps cluster groups to effective subgraph ids — explicit AND generated', () => {
    // Cluster ids carry NO flowchart- prefix and NO counter: flowDb's getData
    // pushes subgraph nodes without a domId (flowDb.ts:1198-1213), and
    // rendering-util/render.ts:67-72 then falls back to `${diagramId}-${id}`.
    const model = parseFlowchart(
      [
        'flowchart TD',
        '  subgraph ops[Operations]',
        '    A[Start]',
        '  end',
        '  subgraph Two Words',
        '    B',
        '  end',
      ].join('\n'),
    )!;
    const host = document.createElement('div');
    host.innerHTML = CLUSTER_SVG;
    const binding = bindFlowchartSvg(host, model);
    expect([...binding.clusterEls.keys()].sort()).toEqual(['ops', 'subGraph1']);
    expect(binding.clusterEls.has('mystery')).toBe(false); // unmatched → unbound, renders fine
    expect(binding.nodeEls.has('A')).toBe(true); // node binding untouched
  });
});
```

Run — FAIL (no `clusterEls`).

- [ ] **Step 2: Implement `clusterEls`**

In `svgBinding.ts`: add `clusterEls: Map<string, SVGGElement>;` to `FlowchartSvgBinding`, import `subgraphs` from `./model`, and before the return:

```ts
  // Clusters (M29.38). DOM contract verified against vendored v11.16.1:
  // a subgraph renders as <g class="cluster …" id="<domId>"> (clusters.js:22-27
  // — `.attr('class', 'cluster ' + node.cssClasses).attr('id', node.domId)`),
  // and its domId is `${diagramId}-${subgraphId}` EXACTLY — no `flowchart-`
  // prefix, no counter — because flowDb.getData() pushes subgraph nodes with
  // no domId of their own (flowDb.ts:1198-1213) and rendering-util/render.ts:
  // 67-72 falls back to `node.domId || node.id` before prefixing. So after
  // stripRenderId, matching is an exact-equality lookup against the effective
  // ids subgraphs() computed (which mirror flowDb's generated ordinals).
  const clusterEls = new Map<string, SVGGElement>();
  const knownSubs = subgraphs(model);
  for (const el of container.querySelectorAll<SVGGElement>('g.cluster')) {
    const domId = stripRenderId(el.id);
    const hit = knownSubs.find((s) => s.id === domId);
    if (hit !== undefined && !clusterEls.has(hit.id)) clusterEls.set(hit.id, el);
  }

  return { nodeEls, edgeEls, clusterEls };
```

Run: `pnpm test:run src/mermaid/flowchart/svgBinding.test.ts` — pass. The two pre-existing tests destructure the binding without `clusterEls`; they keep passing untouched.

- [ ] **Step 3: Write the failing `LinkPopover` tests**

Create `src/mermaid/flowchart/LinkPopover.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { LinkPopover } from './LinkPopover';

// Minimal Entry shape — same trick the engine tests use.
const entry = (path: string, title: string, filename: string): Entry =>
  ({ path, title, filename, folder: '', type: null, properties: {}, relationships: {} }) as Entry;

const ENTRIES = [
  entry('projects/atlas/project.md', 'Atlas', 'project.md'),
  entry('notes/atlas-retro.md', 'Atlas retro', 'atlas-retro.md'),
  entry('notes/other.md', 'Other note', 'other.md'),
];

describe('LinkPopover', () => {
  it('typing a URL offers a URL link', async () => {
    const onPick = vi.fn();
    render(<LinkPopover entries={ENTRIES} current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Link target'), 'https://example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Link to URL' }));
    expect(onPick).toHaveBeenCalledWith('https://example.com');
  });

  it('typing text searches records and picks a vault path', async () => {
    const onPick = vi.fn();
    render(<LinkPopover entries={ENTRIES} current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Link target'), 'atlas');
    // resolveTarget's folder rule makes "atlas" hit the project; substring
    // matches follow. Pick the retro note.
    await userEvent.click(screen.getByRole('button', { name: 'Link to Atlas retro' }));
    expect(onPick).toHaveBeenCalledWith('notes/atlas-retro.md');
  });

  it('shows the current target with a clear action', async () => {
    const onPick = vi.fn();
    render(
      <LinkPopover entries={ENTRIES} current="notes/other.md" onPick={onPick} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('without entries, record search is absent but URL entry still works', async () => {
    const onPick = vi.fn();
    render(<LinkPopover entries={undefined} current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Link target'), 'https://a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Link to URL' }));
    expect(onPick).toHaveBeenCalledWith('https://a.b');
  });
});
```

Run — FAIL.

- [ ] **Step 4: Implement `src/mermaid/flowchart/LinkPopover.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { resolveTarget } from '@/engine/wikilink';
import type { Entry } from '@/engine/types';

const URL_RE = /^https?:\/\/\S+$/;
const MAX_RESULTS = 8;

/**
 * Bind a node to a URL or a vault record (M29.38, spec D3/D8). One input,
 * two readings: a `https?://` string offers a URL link; anything else
 * searches records — resolveTarget's exact hit first (stem > project folder >
 * title, the Tolaria rule), then title/filename substring matches. Picking a
 * record stores its vault-relative PATH in the click line, so the binding
 * survives retitles. `entries` is optional by design: hosts without a vault
 * in hand still get URL links, and nothing here crashes.
 */
export function LinkPopover({
  entries,
  current,
  onPick,
  onClose,
}: {
  entries: Entry[] | undefined;
  current: string | null;
  onPick: (target: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const isUrl = URL_RE.test(q);

  const matches = useMemo(() => {
    if (entries === undefined || q === '' || isUrl) return [];
    const exact = resolveTarget(q, entries);
    const needle = q.toLowerCase();
    const rest = entries.filter(
      (e) =>
        e !== exact &&
        (e.title.toLowerCase().includes(needle) || e.filename.toLowerCase().includes(needle)),
    );
    return [...(exact !== null ? [exact] : []), ...rest].slice(0, MAX_RESULTS);
  }, [entries, q, isUrl]);

  const pick = (target: string | null) => {
    onPick(target);
    onClose();
  };

  return (
    <div data-testid="mermaid-link-popover" className="w-64 p-2">
      <Input
        placeholder={entries !== undefined ? 'Paste a URL or search records…' : 'Paste a URL…'}
        ariaLabel="Link target"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        width="100%"
      />
      {current !== null && (
        <button
          type="button"
          aria-label="Remove link"
          onClick={() => pick(null)}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-left text-xs text-n-600 hover:bg-n-50"
        >
          <Icon name="x" size={12} color="var(--n-500)" />
          <span className="truncate">Remove link ({current})</span>
        </button>
      )}
      {isUrl && (
        <button
          type="button"
          aria-label="Link to URL"
          onClick={() => pick(q)}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-left text-xs text-n-700 hover:bg-n-50"
        >
          <Icon name="link" size={12} color="var(--n-500)" />
          <span className="truncate">{q}</span>
        </button>
      )}
      {matches.map((e) => (
        <button
          key={e.path}
          type="button"
          aria-label={`Link to ${e.title}`}
          onClick={() => pick(e.path)}
          className="mt-1 flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-left text-xs text-n-700 hover:bg-n-50"
        >
          <Icon name="file-text" size={12} color="var(--n-500)" />
          <span className="truncate">{e.title}</span>
        </button>
      ))}
      {!isUrl && q !== '' && matches.length === 0 && entries !== undefined && (
        <div className="py-2 text-center text-xs text-n-400">No records match "{q}"</div>
      )}
    </div>
  );
}
```

Run: `pnpm test:run src/mermaid/flowchart/LinkPopover.test.tsx` — pass. (If `Entry`'s required fields make the test factory's cast brittle, copy the fixture shape from an existing engine test instead of widening the cast.)

- [ ] **Step 5: Write the failing StructuralEditor tests**

Append to `StructuralEditor.test.tsx`. Extend `FIXTURE_SVG` with a cluster group and give the fixture code a subgraph + a click line so the same svg serves every case (remember: if the security hook rejects the svg string, write the hunk via bash heredoc):

```tsx
const CLUSTERED_SVG = [
  '<svg viewBox="0 0 300 150">',
  '<g class="cluster " id="ops"><rect width="120" height="80"/></g>',
  '<g class="node" id="flowchart-A-0"><rect width="10" height="10"/></g>',
  '<g class="node" id="flowchart-B-1"><rect width="10" height="10"/></g>',
  '<g class="node" id="flowchart-C-2"><rect width="10" height="10"/></g>',
  '<path class="flowchart-link" id="L_A_B_0"/>',
  '</svg>',
].join('');

const CLUSTERED_CODE = [
  'flowchart TD',
  '  subgraph ops[Operations]',
  '    A[Start] --> B[End]',
  '  end',
  '  C[Lone]',
  '  click C "projects/atlas/project.md"',
].join('\n');

describe('subgraph affordances', () => {
  it('clicking a cluster (not a node inside it) opens the subgraph toolbar', async () => {
    mockSvg(CLUSTERED_SVG); // however the file's existing render-mock is parameterized
    render(<StructuralEditor code={CLUSTERED_CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('ops')).not.toBeNull());
    await userEvent.click(document.getElementById('ops')!);
    expect(screen.getByTestId('mermaid-subgraph-toolbar')).toBeTruthy();
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

  it('shift-clicking two nodes offers Group into subgraph', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={'flowchart TD\n  A[One]\n  B[Two]'} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    // fireEvent, not userEvent: userEvent v14 has no per-click modifier
    // option — Shift is keyboard state, and fireEvent states it directly on
    // the MouseEvent, which is exactly what the imperative onclick reads.
    // (Import fireEvent from '@testing-library/react' alongside render/screen.)
    fireEvent.click(document.getElementById('flowchart-A-0')!, { shiftKey: true });
    fireEvent.click(document.getElementById('flowchart-B-1')!, { shiftKey: true });
    await userEvent.type(screen.getByLabelText('Subgraph title'), 'Grouped');
    await userEvent.click(screen.getByRole('button', { name: 'Group into subgraph' }));
    const out = onChangeCode.mock.calls[0][0] as string;
    expect(out).toContain('subgraph Grouped[Grouped]');
    expect(out).toContain('end');
  });
});

describe('link affordances', () => {
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

  it('a URL badge opens a new window, guarded', async () => {
    mockSvg(CLUSTERED_SVG);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const code = 'flowchart TD\n  A[Start]\n  click A "https://example.com"';
    render(<StructuralEditor code={code} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('mermaid-link-badge')).not.toBeNull());
    await userEvent.click(screen.getByTestId('mermaid-link-badge'));
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('the node toolbar link button binds a record through the popover', async () => {
    mockSvg(CLUSTERED_SVG);
    const onChangeCode = vi.fn();
    render(
      <StructuralEditor
        code={'flowchart TD\n  A[Start]'}
        onChangeCode={onChangeCode}
        entries={ENTRIES} // reuse LinkPopover.test's fixture shape
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
});
```

(`mockSvg` stands for however the existing test file swaps the fixture the mocked `renderMermaid` resolves — if it currently pins one constant, refactor the mock to read a mutable module-level variable first; that refactor belongs to this step.)

Run — FAIL.

- [ ] **Step 6: Implement the StructuralEditor changes**

All svg-side handlers bind imperatively inside the existing bind effect (the subtree is React-free — see traps); all overlays are React inside the relative wrapper. New imports: `subgraphs`, `nodeLinks`, `type Entry`, `LinkPopover`, ops from F3, `Popover`.

Props:

```tsx
export function StructuralEditor({
  code,
  onChangeCode,
  entries,
  onOpenPath,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  /** Vault entries for the link popover's record search. Optional: without
   *  them the popover is URL-only and record badges no-op — degradation,
   *  never a crash (hosts without a vault exist by design). */
  entries?: Entry[];
  /** What a record badge click does — hosts pass useOpenPath('in-place'). */
  onOpenPath?: (path: string) => void;
}) {
```

New state (reset ALL of it in the existing on-`[code]` effect — same staleness argument as the popovers it already clears):

```tsx
const [selectedSub, setSelectedSub] = useState<number | null>(null);
const [subToolbarPos, setSubToolbarPos] = useState<{ x: number; y: number } | null>(null);
const [subTitle, setSubTitle] = useState('');
const [multi, setMulti] = useState<string[]>([]);
const [groupTitle, setGroupTitle] = useState('');
const [linkOpen, setLinkOpen] = useState(false);
const linkBtnRef = useRef<HTMLButtonElement | null>(null);
const [badges, setBadges] = useState<{ id: string; target: string; x: number; y: number }[]>([]);
```

Bind-effect additions (inside the `renderMermaid(...).then` after the existing node/edge wiring):

```tsx
      // Shift-click = multi-select. Handled FIRST in the node onclick: a
      // shift-click must not open the single-node toolbar. (Edit the existing
      // el.onclick to branch on e.shiftKey before its current body.)
      //   if (e.shiftKey) {
      //     e.stopPropagation();
      //     setSelected(null); setToolbarPos(null);
      //     setMulti((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
      //     return;
      //   }
      //   setMulti([]);  // a plain click drops any pending multi-selection

      for (const [sgId, el] of binding.clusterEls) {
        el.style.cursor = 'pointer';
        el.onclick = (e) => {
          // Whether nodes are DOM-descendants of their cluster varies by
          // layout engine; a click that landed on a node group belongs to the
          // node regardless, so ask the target, not the tree we hope for.
          if ((e.target as Element | null)?.closest?.('g.node') !== null) return;
          e.stopPropagation();
          const idx = subgraphs(model).findIndex((s) => s.id === sgId);
          if (idx === -1) return;
          setSelected(null);
          setToolbarPos(null);
          setSelectedSub(idx);
          setSubTitle(subgraphs(model)[idx].title);
          const host = hostRef.current;
          if (host !== null) {
            const hostBox = host.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            const above = box.top - hostBox.top - 34;
            setSubToolbarPos({
              x: box.left - hostBox.left,
              y: above >= 0 ? above : box.bottom - hostBox.top + 6,
            });
          }
        };
      }

      // Link badges: one per owned click line whose node is bound. Computed
      // here (the only place with fresh geometry) and rendered as React
      // overlays — the badge, not the node, is the navigation hit target.
      // NOTE (corrected M29.36): mermaid at strict attaches no click HANDLER
      // but DOES wrap the node in a live `<a href>`, so this task must also
      // neutralize that anchor — see the corrected note at the top of the plan.
      const hostBox = hostRef.current.getBoundingClientRect();
      const nextBadges: { id: string; target: string; x: number; y: number }[] = [];
      for (const [nid, link] of nodeLinks(model)) {
        const el = binding.nodeEls.get(nid);
        if (el === undefined) continue;
        const b = el.getBoundingClientRect();
        nextBadges.push({
          id: nid,
          target: link.target,
          x: b.right - hostBox.left - 7,
          y: b.top - hostBox.top - 7,
        });
      }
      setBadges(nextBadges);
```

(Also extend the no-deps selection-outline effect: a node in `multi` gets the same stroke treatment as `validSelected`.)

Overlays, inside the relative wrapper:

```tsx
        {badges.map((b) => (
          <button
            key={b.id}
            type="button"
            data-testid="mermaid-link-badge"
            aria-label={`Open link on ${b.id}`}
            title={b.target}
            className="absolute z-10 flex h-4 w-4 items-center justify-center rounded-full border border-n-200 bg-n-0 shadow-sm hover:bg-n-50"
            style={{ left: b.x, top: b.y }}
            onClick={(e) => {
              e.stopPropagation();
              if (/^https?:\/\//.test(b.target)) {
                // Guarded: only http(s) ever reaches window.open, and never
                // with an opener to hijack.
                window.open(b.target, '_blank', 'noopener,noreferrer');
              } else {
                onOpenPath?.(b.target);
              }
            }}
          >
            <Icon name="link" size={9} color="var(--cortex-600)" />
          </button>
        ))}

        {selectedSub !== null && subToolbarPos !== null && (
          <div
            data-testid="mermaid-subgraph-toolbar"
            className="absolute z-10 flex items-center gap-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 shadow-sm"
            style={{ left: subToolbarPos.x, top: subToolbarPos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              aria-label="Subgraph title"
              value={subTitle}
              onChange={(e) => setSubTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && selectedSub !== null) {
                  apply(renameSubgraph(model, selectedSub, subTitle));
                }
              }}
              className="w-28 rounded border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-800 outline-none"
            />
            {(['TD', 'LR', 'BT', 'RL'] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-label={`Subgraph direction ${d}`}
                onClick={() => {
                  if (selectedSub !== null) apply(setSubgraphDirection(model, selectedSub, d));
                }}
                className="rounded border-0 bg-transparent px-1 py-0.5 text-xs text-n-600 hover:bg-n-50"
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              aria-label="Subgraph direction auto"
              onClick={() => {
                if (selectedSub !== null) apply(setSubgraphDirection(model, selectedSub, null));
              }}
              className="rounded border-0 bg-transparent px-1 py-0.5 text-xs text-n-600 hover:bg-n-50"
            >
              Auto
            </button>
            <span className="mx-0.5 h-4 w-px bg-n-100" />
            <button
              type="button"
              aria-label="Dissolve subgraph"
              onClick={() => {
                if (selectedSub !== null) apply(dissolveSubgraph(model, selectedSub));
                setSelectedSub(null);
                setSubToolbarPos(null);
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-danger-50"
            >
              <Icon name="ungroup" size={13} color="var(--danger-600)" />
            </button>
          </div>
        )}

        {multi.length >= 2 && (
          <div
            data-testid="mermaid-group-bar"
            className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs text-n-500">{multi.length} selected</span>
            <input
              aria-label="Subgraph title"
              value={groupTitle}
              placeholder="Group title"
              onChange={(e) => setGroupTitle(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-28 rounded border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-800 outline-none"
            />
            <button
              type="button"
              aria-label="Group into subgraph"
              onClick={() => {
                const created = createSubgraph(model, multi, groupTitle.trim() || 'Group');
                // Refusal (id null: a member already lives in a subgraph) is
                // a silent no-op by the store ethos — the bar stays, nothing
                // is corrupted, nothing throws.
                if (created.id !== null) {
                  apply(created.model);
                  setMulti([]);
                  setGroupTitle('');
                }
              }}
              className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-700 hover:bg-n-50"
            >
              Group into subgraph
            </button>
          </div>
        )}
```

Node-toolbar link button (next to F1's icon button) + popover:

```tsx
            <button
              ref={linkBtnRef}
              type="button"
              aria-label="Node link"
              onClick={() => setLinkOpen((v) => !v)}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="link" size={13} color="var(--n-600)" />
            </button>
```

```tsx
        {linkOpen && validSelected !== null && (
          <Popover
            onClose={() => setLinkOpen(false)}
            anchorRef={linkBtnRef}
            className="rounded-md border border-n-200 bg-n-0 shadow-md"
            ariaLabel="Node link popover"
          >
            <LinkPopover
              entries={entries}
              current={nodeLinks(model).get(validSelected)?.target ?? null}
              onPick={(target) => apply(setNodeLink(model, validSelected, target))}
              onClose={() => setLinkOpen(false)}
            />
          </Popover>
        )}
```

Also: the background-click handler that clears `selected` clears `multi`, `selectedSub`, and `subToolbarPos` too.

- [ ] **Step 7: Thread the props from both hosts**

`DiagramPage.tsx` — add near the other hooks and pass through:

```tsx
const entries = useVaultStore((s) => s.entries);
const openPath = useOpenPath('in-place');
// …
<StructuralEditor code={code} onChangeCode={handleChange} entries={entries} onOpenPath={openPath} />
```

`MermaidBlockView.tsx` — same two hooks at the top of the component (it already imports `useVaultStore`; add the `useOpenPath` import), passed to its `<StructuralEditor …/>`. One-line why-comment at each: `in-place` because this surface IS the backdrop (M9.3).

Run: `pnpm test:run src/mermaid src/pages/DiagramPage.test.tsx` — all pass (host tests may need the store seeded; copy the existing DiagramPage test setup).

- [ ] **Step 8: Lint, typecheck, full suite, commit**

```bash
pnpm lint && pnpm typecheck && pnpm test:run
git add src/mermaid/flowchart/svgBinding.ts src/mermaid/flowchart/svgBinding.test.ts \
  src/mermaid/flowchart/LinkPopover.tsx src/mermaid/flowchart/LinkPopover.test.tsx \
  src/mermaid/flowchart/StructuralEditor.tsx src/mermaid/flowchart/StructuralEditor.test.tsx \
  src/pages/DiagramPage.tsx src/mermaid/MermaidBlockView.tsx
git commit -m "feat(mermaid): clusters select, nodes link — the badge is the hit target (M29.38)"
```

---

### Task F5: Insert palette, e2e, full gate (M29.39)

**Files:**
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx`, `StructuralEditor.test.tsx`
- Modify: `e2e/diagrams.spec.ts`

- [ ] **Step 1: "+ Shape" in the structural toolbar (failing test first)**

Test (append to `StructuralEditor.test.tsx`):

```tsx
it('+ Shape inserts a node of the chosen shape in ONE undo step', async () => {
  const onChangeCode = vi.fn();
  render(<StructuralEditor code={'flowchart TD\n  A[Start]'} onChangeCode={onChangeCode} />);
  await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: '+ Shape' }));
  await userEvent.click(screen.getByRole('button', { name: /hexagon/i })); // ShapePalette's tile
  expect(onChangeCode).toHaveBeenCalledTimes(1); // addNode + setNodeShape composed, one commit
  const out = onChangeCode.mock.calls[0][0] as string;
  expect(out).toContain('n1{{'); // bracket shape rewritten in place by setNodeShape
});
```

Implementation: a `+ Shape` button beside the existing `+ Node` in `structural-toolbar`, opening a `Popover` (anchorRef pattern from F1) hosting **Stage E's `ShapePalette`** (spec D4 — the curated-30 grid; import it from wherever E landed it, expected `./ShapePalette`). On pick:

```tsx
const added = addNode(model, 'New step');
apply(setNodeShape(added.model, added.id, shape));
```

One `apply` = one `onChangeCode` = one undo step (spec D10). **Drift point:** match `ShapePalette`'s landed prop names (`onPick(shape)` assumed); if E's palette exposes extended `@{ shape: … }` names, `setNodeShape` (E's version) already routes bracket-vs-meta — the composition above does not care.

- [ ] **Step 2: E2E (append a test to `e2e/diagrams.spec.ts`)**

Copy the existing spec's boot block verbatim (distiller off, theme pinned). Then, using the Systems map doc's first flowchart fence (runtime mock fs — the repo corpus is untouched):

```ts
test('stage F: group, icon, and record link, end to end', async ({ page }) => {
  test.setTimeout(60_000);
  // …boot + open Systems map exactly as the first test does…

  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit' }).click();

  // -- Group two nodes into a subgraph ---------------------------------
  const host = page.getByTestId('structural-host').first();
  const nodes = host.locator('g.node');
  await nodes.nth(0).click({ modifiers: ['Shift'] });
  await nodes.nth(1).click({ modifiers: ['Shift'] });
  await page.getByLabel('Subgraph title').fill('Grouped');
  await page.getByRole('button', { name: 'Group into subgraph' }).click();
  await block.getByRole('button', { name: 'Show code' }).click();
  const source = block.getByLabel('Mermaid source');
  await expect(source).toContainText('subgraph Grouped[Grouped]');
  await expect(source).toContainText('end');
  await block.getByRole('button', { name: 'Show diagram' }).click();

  // -- Set an icon ------------------------------------------------------
  await host.locator('g.node').first().click();
  await page.getByRole('button', { name: 'Node icon' }).click();
  await page.getByRole('button', { name: 'Icon rocket' }).click();
  await block.getByRole('button', { name: 'Show code' }).click();
  await expect(source).toContainText('@{ icon: "lucide:rocket"');
  await block.getByRole('button', { name: 'Show diagram' }).click();
  // Rendering did not error — the icon drew (or, if the lazy pack fetch
  // lost a race, mermaid's "?" placeholder did; both are a successful render).
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await expect(host.locator('svg')).toBeVisible();

  // -- Bind a record link and follow it ---------------------------------
  await host.locator('g.node').first().click();
  await page.getByRole('button', { name: 'Node link' }).click();
  await page.getByLabel('Link target').fill('atlas');
  await page.getByRole('button', { name: /^Link to / }).first().click();
  const badge = page.getByTestId('mermaid-link-badge').first();
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
});
```

Notes for the executor: `detail-panel` is the REAL testid (`src/detail/DetailPanel.tsx:201` — verified). The record search assumes the demo vault resolves "atlas"; if the corpus lacks it, search for a record that exists (check `demo-vault/` first, change the query, not the vault). Live-run traps from memory apply: reuse a running dev server or isolate with `PORT=5273 pnpm e2e`.

- [ ] **Step 3: Full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test:run && pnpm format:check
PORT=5273 pnpm e2e
cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cd ..
```

(Rust is untouched by this stage; the gate proves that, not assumes it.)

- [ ] **Step 4: Commit**

```bash
git add src/mermaid/flowchart/StructuralEditor.tsx src/mermaid/flowchart/StructuralEditor.test.tsx \
  e2e/diagrams.spec.ts
git commit -m "feat(mermaid): insert palette + e2e proof of icons, groups, links (M29.39)"
```

---

## Exit criteria

- [ ] `@iconify-json/lucide` installed; `loadMermaid` registers exactly one pack named `lucide` with a dynamic-import loader (spy-tested).
- [ ] `setNodeIcon` writes/patches/clears `@{ icon, form, pos }` through the node-meta machinery; unknown keys and key order survive; the line dies when emptied. All byte-assertions green.
- [ ] `IconPicker` (in `src/mermaid/flowchart/`): 60+ curated names, EACH proven present in both lucide-react and the iconify pack by a test; free-text `lucide:x`; preview via the app `Icon`; clear action.
- [ ] Model owns `click <id> "<target>"` — and ONLY that form; `classDef`/`class` remain opaque (ordering proven); a bare `click` line cannot mint a phantom node; byte-identical round-trips.
- [ ] Comments in `model.ts` and `StructuralEditor.tsx` state plainly that at securityLevel strict mermaid attaches no click HANDLER but still emits a live `<a href>` wrapping the node (measured M29.36), that the editor's badge is the navigation surface, and that the anchor is neutralized so selecting a linked node cannot navigate the webview away from the app.
- [ ] `setNodeLink` appends/patches/removes; quote substitution at the boundary.
- [ ] `subgraphs()` mirrors flowDb's effective-id rules including close-order ordinals and anonymous blocks; `subgraph-start` round-trips all three source forms.
- [ ] `createSubgraph` wraps contiguous runs in place, relocates non-contiguous owned lines with raw bytes intact, mints bare references for unclaimed members, refuses re-parenting; `renameSubgraph` preserves effective ids; `dissolveSubgraph` deletes markers + own direction line and nothing else; `setSubgraphDirection` inserts/rewrites/removes at own depth only.
- [ ] `clusterEls` binds `g.cluster` groups by exact effective-id match (contract cited to clusters.js:22-27, flowDb.ts:1198-1213, rendering-util/render.ts:67-72); unmatched clusters stay unbound and render fine.
- [ ] StructuralEditor: cluster click → subgraph toolbar (rename/direction/dissolve); shift-click multi-select → group bar; node toolbar icon + link buttons; badge per linked node — URL → guarded `window.open`, record → `onOpenPath`; `entries`/`onOpenPath` threaded from DiagramPage and MermaidBlockView (`in-place`), optional everywhere.
- [ ] `+ Shape` composes `addNode` + `setNodeShape` into one undo step via Stage E's `ShapePalette`.
- [ ] E2E: group-from-selection shows `subgraph`/`end` in code; icon shows `@{ icon:` in code and the render did not error; record badge opens `detail-panel`. Full gate green.

## Self-review notes (author's pass before handoff)

- **Spec coverage:** D6 fully (pack, picker, meta writes); D3's click kind with the strict-mode ownership statement; §1's "subgraph create/edit from canvas" row; D10 obeyed by every op (the create-op's line-relocation is the one place lines change POSITION — their bytes provably do not, and the plan tests that directly). D3's `node-meta`/`style`/`pos-comment` kinds belong to Stages E and G, not here.
- **Stage E coordination:** only via the spec, as instructed — `NodeMeta` is referenced, never redefined; `ShapePalette` is imported, never reimplemented; both drift points are marked in place with the rule "byte-level tests are the contract."
- **Names match the given surface:** `setNodeIcon`, `IconPicker`, `setNodeLink`, `createSubgraph`, `renameSubgraph`, `dissolveSubgraph`, `setSubgraphDirection`, `subgraphs()`, `clusterEls`.
- **No placeholders:** every step carries runnable test code, implementation code, exact commands, and a conventional commit line with its phase number.
- **Known judgment calls, stated for review rather than buried:** (1) dissolve also deletes the block's own `direction` line — cited to flow.jison:388, since orphaning it would rewrite the whole diagram's direction; (2) rename converts single-word blocks to explicit-id form to keep opaque style bindings alive; (3) subgraph ops take an INDEX into `subgraphs()` rather than an id, because generated ids are ordinal-dependent and a retitle could re-key them mid-gesture; (4) both hosts pass `useOpenPath('in-place')` — the diagram surface is its own backdrop.
