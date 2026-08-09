# M29 Stage E — Full Shape Registry, Styles, and the Extended Edge Grammar (M29.29–M29.34)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the flowchart model from 8 bracket shapes and 4 arrows to mermaid's real surface — `@{ shape: … }` node metadata, `style` lines with color pickers, the full edge grammar (every stroke × head, lengths, edge ids, `animate`) — while every op stays a surgical text edit and every line we don't own survives byte-for-byte.

**Architecture:** All model growth happens in `src/mermaid/flowchart/model.ts` (two new understood line kinds: `node-meta`, `style`; a structured `EdgeArrow` replacing the 4-string `Arrow` union) and `ops.ts` (`setNodeStyle`, `setEdgeArrow`, `setEdgeAnimate`, extended `setNodeShape`). UI lands in two new components — `ShapePalette.tsx` (popover grid over the full 49-shape registry, per spec §4.4) and `NodeStyleMenu.tsx` (token-derived swatches) — plus edge controls in `StructuralEditor.tsx`'s existing edge editor. A new `shapes.ts` holds the verified v11.16.1 shape registry.

**Tech stack:** No new dependencies. The model/ops layers stay pure string+data code — no mermaid, no DOM — which is what keeps this stage unit-testable to the byte.

**Spec:** `docs/superpowers/specs/2026-08-09-cerebro-m29-wave2-parity-design.md` — decisions **D3** (new line kinds), **D4** (shape strategy), **D5** (style lines), **D10** (surgical invariant).
**Prerequisites:** Stages A–C (merged in `m29-mermaid` history). Stage D (M29.24–.28) may land before or after this stage: nothing here touches `CanvasViewport`/`FullScreenDiagramEditor` — the UI tasks modify `StructuralEditor`, which every host renders.

---

## The invariants this stage answers to (D10)

1. **Surgical edits only.** Every op touches exactly the lines it must; `serialize()` re-emits `raw` for every non-dirty line, so opacity is preserved *by construction*. Node ids never change. Every new understood kind ships with byte-identical round-trip proofs, exactly like the M29.14 originals.
2. **Editing degrades; rendering never does.** Any line the parser cannot own 100% goes opaque — a multi-line `@{` block, a mismatched arrow, a `\,`-escaped style value. Opaque is never wrong.
3. **One op = one `onChangeCode` = one undo step**, through the same channel typing uses.

Two Stage-C review scars this plan carries forward on purpose (do NOT "fix" them back):

- **Stadium's closer is `])`**, not `)]` — `([` opens, `])` closes. The `SHAPE_BRACKETS`/`SHAPES` tables in the worktree are already correct; any code emitted here must match them.
- **`setEdgeLabel` sanitizes `|` → `/`** before emission (the pipe is the label's own delimiter; a literal one corrupts the line). The same last-boundary discipline applies to every new emitter in this stage: meta values sanitize `"` → `'` and drop `^` (both illegal in `@{ … }` bodies).

## Verified mermaid v11.16.1 facts this stage stands on

Source: vendored mermaid at `docs/examples/mermaid-develop` in the **main checkout** (the worktree gitignores `docs/examples/`). Cite, don't re-derive:

- `@{ … }` node metadata: the lexer treats a single-line body as a YAML **flow mapping** wrapped in `{…}` — values containing `,` or `:` must be quoted; `^` and unescaped `"` are illegal in bare values (lexer class `[^}^"]+`). Multi-line YAML block form also works (we treat it as opaque). Unknown keys are silently ignored by mermaid — safe to round-trip; **we preserve them**. Known keys: `shape`, `label`, `labelType`, `icon`, `form`, `pos`, `img`, `w`, `h`, `constraint`.
- Shape validation: names must be lowercase, no underscore, and in the 49-entry registry, else a render error. `doublecircle` works though undocumented. **`ellipse` is broken upstream (#5976) — we never write it.**
- `style <id> k:v,…` grammar: comma-separated declarations, `#` hex fine; the text-color key is `color`. **Styling an undeclared id auto-creates a node** — never emit `style` for an id the diagram doesn't declare. `linkStyle` **throws** on an out-of-range index — we do not emit `linkStyle` this wave (it stays opaque).
- Edge grammar, full surface: `--> --- --o --x <--> o--o x--x` × normal / thick (`==`) / dotted (`-.-`), plus `~~~` invisible; extra body characters lengthen the edge (upstream caps minlen at 10). Edge ids: `A e1@--> B` (lexer `[^\s"]+@(?=[^{"])`), then `e1@{ animate: true }` / `animation: fast|slow` / `curve: …` (v11.10+). Mermaid's id resolution for `@{ }` lines is subgraph→edge→node; ours can key purely on syntax. Mismatched start/end strokes are INVALID.

## Repo traps (read before every task)

- `pnpm test:run`, never `pnpm test` — watch mode never exits.
- **No jest-dom.** Assert `expect(el).toBeTruthy()` / `expect(queryBy…).toBeNull()`, never `toBeInTheDocument()`.
- `pnpm lint` is zero-warning (`--max-warnings=0`); every `eslint-disable` states its reason in place.
- Component unit tests **mock `../render`** with a fixture svg (the Stage-C pattern in `StructuralEditor.test.tsx`). The model/ops tests in E1–E3 need **no mermaid at all** — they are pure string tests.
- The repo's security hook can block file writes containing raw HTML/SVG string literals. If a Write/Edit of a test file with `<svg …>` fixtures is rejected, create it with a Bash heredoc (`cat > path <<'EOF' … EOF`) instead — content identical, byte-escaped route.
- e2e reuses a running dev server; a stale HMR'd :5173 fails everything at boot — use `PORT=5273 pnpm e2e`.
- Prettier: 100 cols, single quotes. Run `pnpm format` before committing if unsure.
- No corpus (`demo-vault/`) edits are needed in this stage — the e2e task drives the existing Systems map doc against the in-memory mock fs.

---

### Task E1: `node-meta` — `id@{ … }` lines become understood (M29.29)

`A@{ shape: cloud }` is how mermaid v11.3+ names the other 41 shapes, and `e1@{ animate: true }` reuses the identical syntax for edges. One line kind covers both; only the *interpretation* of the id differs (Task E3 teaches `nodes()` to tell them apart). Meta preserves **all** keys in source order — `entries: [string, string][]` is the emission source of truth (an ordered pair list, not the spec sketch's `raw: Record` — a record's ordering is an implementation accident; the pair list makes it a guarantee). The understood keys are additionally surfaced typed (`shape`/`icon`/`form`/`pos`/`label`) for readers.

**Decided here (and proven by test): a bracket+meta hybrid on one line — `A[Label]@{ shape: circle }` — goes opaque.** It is the simplest CORRECT handling: the line survives byte-for-byte, the diagram renders through real mermaid untouched, and the node stays resolvable through its other reference sites. Owning the hybrid would mean a node token carrying two competing shape channels through every emitter; opacity costs only "that one line isn't visually editable," which is invariant 2 working as designed.

**Files:**
- Modify: `src/mermaid/flowchart/model.ts`
- Modify: `src/mermaid/flowchart/model.test.ts`
- Modify: `src/mermaid/flowchart/ops.ts` (one function: `renameNode` learns meta labels)
- Modify: `src/mermaid/flowchart/ops.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/mermaid/flowchart/model.test.ts` (extend the existing import from `./model` with `nodeMeta`, `withMetaEntry`, and `type NodeMeta`):

```ts
describe('node-meta lines (M29.29)', () => {
  const META = [
    'flowchart TD',
    '  A[Start] --> B',
    '  A@{ shape: cloud }',
    '  B@{ shape: cyl, label: "Orders, archived", w: 120, foo: bar }',
  ].join('\n');

  it('parses a single-line meta into ordered entries plus typed keys', () => {
    const model = parseFlowchart(META)!;
    const line = model.lines[3].parsed;
    expect(line.kind).toBe('node-meta');
    if (line.kind !== 'node-meta') return;
    expect(line.id).toBe('B');
    expect(line.meta.entries).toEqual([
      ['shape', 'cyl'],
      ['label', 'Orders, archived'],
      ['w', '120'],
      ['foo', 'bar'],
    ]);
    expect(line.meta.shape).toBe('cyl');
    expect(line.meta.label).toBe('Orders, archived');
  });

  it('round-trips meta-rich sources byte-identically', () => {
    expect(serialize(parseFlowchart(META)!)).toBe(META);
  });

  it('nodeMeta maps ids to their meta, last line winning', () => {
    const m = parseFlowchart('flowchart TD\n  A\n  A@{ shape: hex }\n  A@{ shape: cloud }')!;
    expect(nodeMeta(m).get('A')?.shape).toBe('cloud');
  });

  it('nodes() merges meta shape and label so the resolved view is truthful', () => {
    const n = nodes(parseFlowchart(META)!);
    expect(n.get('A')).toEqual({ label: 'Start', shape: 'rect', metaShape: 'cloud' });
    expect(n.get('B')).toEqual({ label: 'Orders, archived', shape: 'rect', metaShape: 'cyl' });
  });

  it('a meta-only line declares its node', () => {
    const m = parseFlowchart('flowchart TD\n  Cache@{ shape: cyl, label: Store }')!;
    expect(nodes(m).get('Cache')).toEqual({ label: 'Store', shape: 'rect', metaShape: 'cyl' });
  });

  it('multi-line meta blocks and bracket+meta hybrids go opaque, not wrong', () => {
    const src = [
      'flowchart TD',
      '  A[Start] --> B',
      '  B@{',
      '    shape: circle',
      '  }',
      '  A[Start]@{ shape: circle }',
    ].join('\n');
    const model = parseFlowchart(src)!;
    for (const idx of [2, 3, 4, 5]) expect(model.lines[idx].parsed.kind).toBe('opaque');
    expect(serialize(model)).toBe(src);
    // The hybrid line is opaque, but A itself stays resolvable via the edge line.
    expect(nodes(model).get('A')).toEqual({ label: 'Start', shape: 'rect' });
  });

  it('illegal single-line bodies go opaque: bare commas, colons, carets, quotes', () => {
    for (const bad of [
      'A@{ shape: big circle: yes }',
      'A@{ label: has, comma }',
      'A@{ shape: a^b }',
      'A@{ shape: "un"closed }',
    ]) {
      const m = parseFlowchart(`flowchart TD\n  ${bad}`)!;
      expect(m.lines[1].parsed.kind).toBe('opaque');
      expect(serialize(m)).toBe(`flowchart TD\n  ${bad}`);
    }
  });

  it('withMetaEntry adds, replaces, and removes while preserving order', () => {
    const base: NodeMeta = {
      entries: [
        ['shape', 'hex'],
        ['w', '120'],
      ],
      shape: 'hex',
    };
    expect(withMetaEntry(base, 'shape', 'cloud').entries).toEqual([
      ['shape', 'cloud'],
      ['w', '120'],
    ]);
    expect(withMetaEntry(base, 'shape', 'cloud').shape).toBe('cloud');
    expect(withMetaEntry(base, 'pos', 't').entries).toEqual([
      ['shape', 'hex'],
      ['w', '120'],
      ['pos', 't'],
    ]);
    expect(withMetaEntry(base, 'w', null).entries).toEqual([['shape', 'hex']]);
  });

  it('dirty meta lines re-quote values that need it and sanitize illegal characters', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ shape: hex }')!;
    const line = m.lines[1];
    if (line.parsed.kind !== 'node-meta') throw new Error('expected node-meta');
    line.parsed.meta = withMetaEntry(line.parsed.meta, 'label', 'a, b: "c" ^d');
    line.dirty = true;
    expect(serialize(m)).toBe(`flowchart TD\n  A@{ shape: hex, label: "a, b: 'c' d" }`);
  });
});
```

Append to `src/mermaid/flowchart/ops.test.ts`:

```ts
describe('renameNode and node-meta (M29.29)', () => {
  it('renames through the meta label when one exists — a bracket edit would render stale', () => {
    const m = parseFlowchart('flowchart TD\n  A[Old] --> B\n  A@{ shape: cloud, label: Older }')!;
    const out = serialize(renameNode(m, 'A', 'New'));
    expect(out).toContain('A@{ shape: cloud, label: New }');
    expect(out).toContain('A[Old] --> B'); // the bracket site is untouched
  });

  it('a meta line without a label key still renames through brackets', () => {
    const m = parseFlowchart('flowchart TD\n  A[Old] --> B\n  A@{ shape: cloud }')!;
    const out = serialize(renameNode(m, 'A', 'New'));
    expect(out).toContain('A[New] --> B');
    expect(out).toContain('A@{ shape: cloud }');
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/flowchart/model.test.ts src/mermaid/flowchart/ops.test.ts`
Expected: FAIL — `nodeMeta`, `withMetaEntry`, `NodeMeta` not exported; meta lines currently parse opaque.

- [ ] **Step 3: Implement the model side (`model.ts`)**

Five edits, in file order:

**(a)** After the `NodeRef` interface, add the meta types:

```ts
/**
 * Metadata carried by an `id@{ … }` line (M29.29) — mermaid v11.3+'s door to
 * the full shape registry, icons, and (for edge ids) animation.
 *
 * `entries` is the emission source of truth: EVERY key in source order,
 * unknown ones included, values stored unquoted. The typed fields are
 * derived views over `entries` for the keys we understand — always rebuilt
 * through `buildMeta`/`withMetaEntry`, never written directly, so they can
 * never drift from the entries they mirror.
 */
export interface NodeMeta {
  entries: [string, string][];
  shape?: string;
  icon?: string;
  form?: string;
  pos?: string;
  label?: string;
}

const TYPED_META_KEYS = ['shape', 'icon', 'form', 'pos', 'label'] as const;

function buildMeta(entries: [string, string][]): NodeMeta {
  const meta: NodeMeta = { entries };
  for (const [key, value] of entries) {
    if ((TYPED_META_KEYS as readonly string[]).includes(key)) {
      meta[key as (typeof TYPED_META_KEYS)[number]] = value;
    }
  }
  return meta;
}

/** New meta with `key` set (replacing in place, order kept) or removed (`null`). */
export function withMetaEntry(meta: NodeMeta, key: string, value: string | null): NodeMeta {
  const entries: [string, string][] = [];
  let replaced = false;
  for (const [k, v] of meta.entries) {
    if (k === key) {
      if (value !== null && !replaced) {
        entries.push([k, value]);
        replaced = true;
      }
      // value === null → drop; a duplicate key collapses onto its first site
    } else {
      entries.push([k, v]);
    }
  }
  if (value !== null && !replaced) entries.push([key, value]);
  return buildMeta(entries);
}

/**
 * Parse a single-line `@{ … }` body — a YAML flow mapping per the v11.16.1
 * lexer. Bare values may not contain `,` `:` `"` `^` (quote them instead);
 * `^` is illegal even quoted (lexer class `[^}^"]+`), and nested braces mean
 * a body we don't own. Any violation → null → the line goes opaque.
 */
function parseMetaBody(body: string): NodeMeta | null {
  if (/[{}^]/.test(body)) return null;
  const parts: string[] = [];
  let quote = false;
  let cur = '';
  for (const ch of body) {
    if (ch === '"') quote = !quote;
    if (ch === ',' && !quote) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur);

  const entries: [string, string][] = [];
  for (const part of parts) {
    const item = part.trim();
    if (item === '') return null;
    const colon = item.indexOf(':');
    if (colon === -1) return null;
    const key = item.slice(0, colon).trim();
    let value = item.slice(colon + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return null;
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) return null;
      value = value.slice(1, -1);
      if (value.includes('"')) return null;
    } else if (value === '' || /[:"]/.test(value)) {
      return null;
    }
    entries.push([key, value]);
  }
  return buildMeta(entries);
}
```

**(b)** Extend `ParsedLine`:

```ts
export type ParsedLine =
  | { kind: 'header'; keyword: 'flowchart' | 'graph'; direction: Direction }
  | { kind: 'node'; node: NodeRef }
  | { kind: 'node-meta'; id: string; meta: NodeMeta }
  | { kind: 'edges'; segments: EdgeSegment[] }
  | { kind: 'subgraph-start'; title: string }
  | { kind: 'subgraph-end' }
  | { kind: 'opaque' };
```

**(c)** In `parseLine`, after the anonymous-subgraph guard (`if (trimmed === 'subgraph') …`) and **before** the arrow check, add:

```ts
  // `id@{ … }` on one line — node metadata, or edge metadata for an edge id
  // (identical syntax; nodes()/ops tell them apart by what the id names).
  // Failure to own the body means opaque, never a guess. The bracket+meta
  // hybrid `A[Label]@{ … }` does not match this pattern (the id charset has
  // no `[`), falls through, fails the node-token attempt, and lands opaque —
  // decided and proven in M29.29's tests.
  const metaMatch = trimmed.match(/^([A-Za-z0-9_.-]+)@\{(.*)\}$/);
  if (metaMatch !== null) {
    const meta = parseMetaBody(metaMatch[2]);
    return meta === null ? { kind: 'opaque' } : { kind: 'node-meta', id: metaMatch[1], meta };
  }
```

(A multi-line `@{` opener never matches — no closing `}` on the line — and each continuation line fails every other parser, so whole blocks go opaque line-by-line and round-trip via `raw`.)

**(d)** In `emitLine`, add the case (next to `case 'node'`), plus its value emitter near `quoteLabel`:

```ts
/**
 * Quote a meta value when the flow mapping demands it (`,` `:` braces, `#`,
 * or edge whitespace/emptiness). `"` and `^` are illegal in `@{ … }` bodies
 * altogether, so — same last-boundary discipline as setEdgeLabel's pipe —
 * they are substituted here rather than corrupting the file.
 */
function emitMetaValue(value: string): string {
  const cleaned = value.replaceAll('"', "'").replaceAll('^', '');
  return /[,:{}#]|^\s|\s$|^$/.test(cleaned) ? `"${cleaned}"` : cleaned;
}
```

```ts
    case 'node-meta':
      return `${indent}${p.id}@{ ${p.meta.entries
        .map(([k, v]) => `${k}: ${emitMetaValue(v)}`)
        .join(', ')} }`;
```

Note the double-sanitize: `'a, b: "c" ^d'` → `"`→`'`, `^` dropped → `a, b: 'c' d` — contains `,`/`:` → quoted. That is exactly the byte string the Step-1 test pins.

**(e)** Add `nodeMeta` and grow `nodes()`:

```ts
/** Meta per id — the LAST meta line for an id wins, mirroring mermaid's sequential apply. */
export function nodeMeta(model: FlowchartModel): Map<string, NodeMeta> {
  const out = new Map<string, NodeMeta>();
  for (const line of model.lines) {
    if (line.parsed.kind === 'node-meta') out.set(line.parsed.id, line.parsed.meta);
  }
  return out;
}
```

Change `nodes()`'s signature and add the merge pass at its end (before `return out`). The value type gains an *optional* `metaShape` — optional so every existing `toEqual({ label, shape })` assertion keeps passing untouched:

```ts
export interface ResolvedNode {
  label: string;
  shape: Shape;
  /** Registry shape from a meta line, when one overrides the brackets. */
  metaShape?: string;
}

/** Resolved view: definition line wins, else first labeled inline site, else the id; meta overrides both. */
export function nodes(model: FlowchartModel): Map<string, ResolvedNode> {
```

…and after the existing line loop:

```ts
  // Meta lines both declare nodes (a lone `A@{ shape: cyl }` is a real
  // declaration) and refine already-declared ones: meta label and shape win
  // at render time, so the resolved view must say so.
  for (const [id, meta] of nodeMeta(model)) {
    const existing = out.get(id);
    if (existing === undefined) {
      const fresh: ResolvedNode = { label: meta.label ?? id, shape: 'rect' };
      if (meta.shape !== undefined) fresh.metaShape = meta.shape;
      out.set(id, fresh);
    } else {
      if (meta.label !== undefined) existing.label = meta.label;
      if (meta.shape !== undefined) existing.metaShape = meta.shape;
    }
  }
  return out;
```

(Task E3 adds the edge-id exclusion here once segments can carry ids; until then no id can be an edge id, so the merge is complete as written.)

- [ ] **Step 4: Implement the ops side — `renameNode` learns meta labels**

In `ops.ts`, extend the imports from `./model` with `withMetaEntry`, and add this block at the top of `renameNode`, before the `findLabelSite` call:

```ts
  // A meta `label:` wins over any bracket label at render time, so when one
  // exists the rename must land THERE — editing brackets would leave the
  // visible text unchanged and the "rename" silently ineffective.
  for (let i = next.lines.length - 1; i >= 0; i -= 1) {
    const parsed = next.lines[i].parsed;
    if (parsed.kind === 'node-meta' && parsed.id === id && parsed.meta.label !== undefined) {
      parsed.meta = withMetaEntry(parsed.meta, 'label', label);
      next.lines[i].dirty = true;
      return next;
    }
  }
```

(Backwards walk because the LAST meta line wins in `nodeMeta` — patch the one that renders. A meta line *without* a `label` key changes nothing: brackets still carry the visible text, and the existing path handles it — the second Step-1 ops test pins that.)

- [ ] **Step 5: Run the tests; iterate until green**

Run: `pnpm test:run src/mermaid/flowchart/`
Expected: all pass, including every pre-existing Stage-C test — `metaShape` is optional precisely so none of them move.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/model.ts src/mermaid/flowchart/model.test.ts src/mermaid/flowchart/ops.ts src/mermaid/flowchart/ops.test.ts
git commit -m "feat(mermaid): node metadata lines are understood, ordered, and byte-safe (M29.29)"
```

---

### Task E2: `style` lines + `setNodeStyle` (M29.30)

`style A fill:#f96,stroke:#333` becomes an understood kind so color edits can be surgical: change/add/remove exactly the named declarations, preserve unknown ones in order, delete the line when it empties, create it when absent. Styles target **nodes** this wave (no `linkStyle` — it throws on a bad index and stays opaque; no classDef authoring — D5).

**Files:**
- Modify: `src/mermaid/flowchart/model.ts`
- Modify: `src/mermaid/flowchart/model.test.ts`
- Modify: `src/mermaid/flowchart/ops.ts`
- Modify: `src/mermaid/flowchart/ops.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `model.test.ts` (extend the `./model` import with `nodeStyle`):

```ts
describe('style lines (M29.30)', () => {
  const STYLED = [
    'flowchart TD',
    '  A[Start] --> B{Choice}',
    '  style A fill:#f96,stroke:#333,stroke-width:2px',
  ].join('\n');

  it('parses declarations in order', () => {
    const m = parseFlowchart(STYLED)!;
    const line = m.lines[2].parsed;
    expect(line.kind).toBe('style');
    if (line.kind !== 'style') return;
    expect(line.id).toBe('A');
    expect(line.decls).toEqual([
      ['fill', '#f96'],
      ['stroke', '#333'],
      ['stroke-width', '2px'],
    ]);
  });

  it('round-trips untouched style lines byte-identically, spacing quirks included', () => {
    const quirky = 'flowchart TD\n  A --> B\n  style A fill: #f96 , stroke:#333';
    expect(serialize(parseFlowchart(quirky)!)).toBe(quirky);
  });

  it('linkStyle and classDef stay opaque; an unowned style body goes opaque', () => {
    const m = parseFlowchart(
      [
        'flowchart TD',
        '  A --> B',
        '  linkStyle 0 stroke:#f00',
        '  style A fill',
        '  classDef hot fill:#f96',
      ].join('\n'),
    )!;
    expect(m.lines[2].parsed.kind).toBe('opaque');
    expect(m.lines[3].parsed.kind).toBe('opaque');
    expect(m.lines[4].parsed.kind).toBe('opaque');
  });

  it('nodeStyle reads the first style line as a record', () => {
    const m = parseFlowchart(STYLED)!;
    expect(nodeStyle(m, 'A')).toEqual({ fill: '#f96', stroke: '#333', 'stroke-width': '2px' });
    expect(nodeStyle(m, 'B')).toEqual({});
  });
});
```

Append to `ops.test.ts` (extend the ops import with `setNodeStyle`):

```ts
describe('setNodeStyle (M29.30)', () => {
  const STYLED = [
    'flowchart TD',
    '  A[Start] --> B{Choice}',
    '  style A fill:#f96,stroke:#333,stroke-width:2px',
  ].join('\n');

  it('patches named declarations surgically, unknown ones kept in order', () => {
    const m = parseFlowchart(STYLED)!;
    const out = serialize(setNodeStyle(m, 'A', { fill: '#eef1fe', color: '#3d5bde' }));
    expect(out).toContain('style A fill:#eef1fe,stroke:#333,stroke-width:2px,color:#3d5bde');
    expect(out).toContain('A[Start] --> B{Choice}'); // nothing else moved
  });

  it('creates the line right after the node when absent', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B\n  B --> C')!;
    const out = serialize(setNodeStyle(m, 'A', { fill: '#f96' }));
    expect(out).toBe('flowchart TD\n  A[Start] --> B\n  style A fill:#f96\n  B --> C');
  });

  it('removing the last declaration deletes the line', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  style A fill:#f96')!;
    expect(serialize(setNodeStyle(m, 'A', { fill: null }))).toBe('flowchart TD\n  A --> B');
  });

  it('never styles an id the diagram does not declare — upstream would auto-create it', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    expect(serialize(setNodeStyle(m, 'Ghost', { fill: '#f96' }))).toBe('flowchart TD\n  A --> B');
  });

  it('a patch of only-nulls on a styleless node changes nothing', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    expect(serialize(setNodeStyle(m, 'A', { fill: null }))).toBe('flowchart TD\n  A --> B');
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/flowchart/`
Expected: FAIL — `style` lines parse opaque; `setNodeStyle`/`nodeStyle` missing.

- [ ] **Step 3: Implement the model side**

**(a)** Drop `style` from the keyword blocklist:

```ts
const OPAQUE_KEYWORDS = /^(classDef|class|linkStyle|click|direction|accTitle|accDescr)\b/;
```

**(b)** Extend `ParsedLine` with:

```ts
  | { kind: 'style'; id: string; decls: [string, string][] }
```

**(c)** In `parseLine`, immediately after the `OPAQUE_KEYWORDS` test:

```ts
  // `style <id> k:v,…`. A body we can't own 100% — a `\,`-escaped value, a
  // declaration with no colon — sends the WHOLE line opaque, never a guess.
  const styleMatch = trimmed.match(/^style\s+([A-Za-z0-9_.-]+)\s+(\S.*)$/);
  if (styleMatch !== null) {
    const decls = parseStyleDecls(styleMatch[2]);
    return decls === null ? { kind: 'opaque' } : { kind: 'style', id: styleMatch[1], decls };
  }
```

with the helper nearby:

```ts
function parseStyleDecls(text: string): [string, string][] | null {
  if (text.includes('\\,')) return null; // classDef-style escaped commas: not ours
  const decls: [string, string][] = [];
  for (const part of text.split(',')) {
    const item = part.trim();
    if (item === '') return null;
    const colon = item.indexOf(':');
    if (colon === -1) return null;
    const key = item.slice(0, colon).trim();
    const value = item.slice(colon + 1).trim();
    if (!/^[A-Za-z-]+$/.test(key) || value === '') return null;
    decls.push([key, value]);
  }
  return decls;
}
```

**(d)** `emitLine` gains (dirty lines emit canonical `k:v,` spacing — untouched lines keep their quirks via `raw`, which the quirky-spacing round-trip test proves):

```ts
    case 'style':
      return `${indent}style ${p.id} ${p.decls.map(([k, v]) => `${k}:${v}`).join(',')}`;
```

**(e)** Reader helper:

```ts
/** The FIRST style line's declarations for `id`, as a record ({} when unstyled). */
export function nodeStyle(model: FlowchartModel, id: string): Record<string, string> {
  for (const line of model.lines) {
    if (line.parsed.kind === 'style' && line.parsed.id === id) {
      return Object.fromEntries(line.parsed.decls);
    }
  }
  return {};
}
```

- [ ] **Step 4: Implement `setNodeStyle` in `ops.ts`**

```ts
/** Where a new companion line (style, meta) belongs: after the node's
 * definition line, else after the first line that references it, else the
 * header. Never BEFORE the node exists — a style statement ahead of its node
 * would auto-create one upstream. */
function anchorLineFor(model: FlowchartModel, id: string): number {
  for (let i = 0; i < model.lines.length; i += 1) {
    const parsed = model.lines[i].parsed;
    if (parsed.kind === 'node' && parsed.node.id === id) return i;
  }
  for (let i = 0; i < model.lines.length; i += 1) {
    const parsed = model.lines[i].parsed;
    if (parsed.kind === 'node-meta' && parsed.id === id) return i;
    let hit = false;
    eachRef(model.lines[i], (ref) => {
      if (ref.id === id) hit = true;
    });
    if (hit) return i;
  }
  return headerIndex(model);
}

function patchDecls(
  decls: [string, string][],
  patch: Record<string, string | null>,
): [string, string][] {
  let out = decls;
  for (const [key, value] of Object.entries(patch)) {
    const next: [string, string][] = [];
    let replaced = false;
    for (const [k, v] of out) {
      if (k === key) {
        if (value !== null && !replaced) {
          next.push([k, value]);
          replaced = true;
        }
      } else {
        next.push([k, v]);
      }
    }
    if (value !== null && !replaced) next.push([key, value]);
    out = next;
  }
  return out;
}

/**
 * Patch a node's `style` line surgically (M29.30): change/add/remove exactly
 * the named declarations, keep unknown ones in order, delete the line when it
 * empties, create it (after the node) when absent. Unknown ids are a no-op —
 * upstream auto-creates a node for a styled undeclared id, which is exactly
 * the kind of surprise this layer exists to prevent.
 */
export function setNodeStyle(
  model: FlowchartModel,
  id: string,
  patch: Record<string, string | null>,
): FlowchartModel {
  const next = clone(model);
  if (!nodes(next).has(id)) return next;

  const idx = next.lines.findIndex((l) => l.parsed.kind === 'style' && l.parsed.id === id);
  if (idx !== -1) {
    const parsed = next.lines[idx].parsed;
    if (parsed.kind !== 'style') return next; // unreachable; narrows the type
    const decls = patchDecls(parsed.decls, patch);
    if (decls.length === 0) {
      next.lines.splice(idx, 1);
    } else {
      parsed.decls = decls;
      next.lines[idx].dirty = true;
    }
    return next;
  }

  const decls = patchDecls([], patch);
  if (decls.length === 0) return next;
  const at = anchorLineFor(next, id);
  const indent = next.lines[at]?.raw.match(/^\s*/)?.[0] ?? '  ';
  next.lines.splice(at + 1, 0, {
    raw: indent,
    parsed: { kind: 'style', id, decls },
    dirty: true,
  });
  return next;
}
```

(Multiple `style` lines for one id: the first is patched, the rest stay untouched — mermaid merges them sequentially, and touching more than asked would violate the surgical rule.)

- [ ] **Step 5: Run, lint, commit**

```bash
pnpm test:run src/mermaid/flowchart/ && pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/
git commit -m "feat(mermaid): style lines parse and patch surgically (M29.30)"
```

---

### Task E3: The full edge grammar — strokes, heads, lengths, ids, animate (M29.31)

The 4-string `Arrow` union becomes a structured `EdgeArrow { stroke, head, raw }`. `raw` is the verbatim source token and the emission truth for untouched segments — so a dirty line (label edit on segment 0) still emits segment 1's `o==o` byte-for-byte. The typed decomposition:

- `EdgeStroke = 'normal' | 'thick' | 'dotted' | 'invisible'`
- `EdgeHead = 'arrow' | 'open' | 'circle' | 'cross' | 'double'` — `'double'` covers all three bidirectional families (`<-->`, `o--o`, `x--x`); which family is preserved through `raw`, and rewrites keep an existing `o`/`x` family rather than flattening it to `<…>` (a start-marker field would buy nothing `raw` doesn't already carry).

Rewritten arrows normalize to **minimum length** (a length UI is out of scope; the raw token preserves author-chosen lengths until the segment itself is edited). Edge ids (`A e1@--> B`) parse as part of the edge line so such lines stay understood; `e1@{ animate: true }` reuses E1's `node-meta` machinery keyed purely on syntax.

**Files:**
- Modify: `src/mermaid/flowchart/model.ts`
- Modify: `src/mermaid/flowchart/model.test.ts`
- Modify: `src/mermaid/flowchart/ops.ts`
- Modify: `src/mermaid/flowchart/ops.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `model.test.ts` (extend the `./model` import with `edgeAnimated`):

```ts
describe('extended edge grammar (M29.31)', () => {
  it('parses every stroke × head combination, raw tokens intact', () => {
    const src = [
      'flowchart TD',
      '  A --o B',
      '  B --x C',
      '  C <--> D',
      '  D o--o E',
      '  E x==x F',
      '  F ==> G',
      '  G === H',
      '  H -..-> I',
      '  I ~~~ J',
      '  J ----> K',
    ].join('\n');
    const m = parseFlowchart(src)!;
    expect(m.lines.slice(1).every((l) => l.parsed.kind === 'edges')).toBe(true);
    const e = edges(m);
    expect(e[0].arrow).toEqual({ stroke: 'normal', head: 'circle', raw: '--o' });
    expect(e[1].arrow).toEqual({ stroke: 'normal', head: 'cross', raw: '--x' });
    expect(e[2].arrow).toEqual({ stroke: 'normal', head: 'double', raw: '<-->' });
    expect(e[3].arrow).toEqual({ stroke: 'normal', head: 'double', raw: 'o--o' });
    expect(e[4].arrow).toEqual({ stroke: 'thick', head: 'double', raw: 'x==x' });
    expect(e[5].arrow).toEqual({ stroke: 'thick', head: 'arrow', raw: '==>' });
    expect(e[6].arrow).toEqual({ stroke: 'thick', head: 'open', raw: '===' });
    expect(e[7].arrow).toEqual({ stroke: 'dotted', head: 'arrow', raw: '-..->' });
    expect(e[8].arrow).toEqual({ stroke: 'invisible', head: 'open', raw: '~~~' });
    expect(e[9].arrow).toEqual({ stroke: 'normal', head: 'arrow', raw: '---->' });
    expect(serialize(m)).toBe(src);
  });

  it('mismatched markers, lone starts, and labeled invisibles are not ours', () => {
    for (const bad of ['A o--x B', 'A <--o B', 'A <-- B', 'A ~~~|no| B']) {
      const m = parseFlowchart(`flowchart TD\n  ${bad}`)!;
      expect(m.lines[1].parsed.kind).toBe('opaque');
      expect(serialize(m)).toBe(`flowchart TD\n  ${bad}`);
    }
  });

  it('edge ids ride their segment and round-trip', () => {
    const src = 'flowchart TD\n  A e1@-->|go| B e2@--> C';
    const m = parseFlowchart(src)!;
    const e = edges(m);
    expect(e[0]).toMatchObject({ from: 'A', to: 'B', id: 'e1', label: 'go' });
    expect(e[1]).toMatchObject({ from: 'B', to: 'C', id: 'e2' });
    expect(serialize(m)).toBe(src);
  });

  it('an edge-meta id is meta, not a node', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animate: true }')!;
    expect(m.lines[2].parsed.kind).toBe('node-meta');
    expect(nodes(m).has('e1')).toBe(false);
    expect(nodes(m).has('A')).toBe(true);
    expect(edgeAnimated(m, edges(m)[0])).toBe(true);
  });
});
```

Append to `ops.test.ts` (extend the ops import with `newEdgeId`, `setEdgeArrow`, `setEdgeAnimate`):

```ts
describe('setEdgeArrow (M29.31)', () => {
  it('rewrites only its segment; line-mates stay byte-true', () => {
    const m = parseFlowchart('flowchart TD\n  A -->|go| B o==o C')!;
    const target = edges(m).find((e) => e.from === 'A')!;
    expect(serialize(setEdgeArrow(m, target, { head: 'circle' }))).toBe(
      'flowchart TD\n  A --o|go| B o==o C',
    );
  });

  it('normalizes length on rewrite and keeps the o/x family on stroke-only changes', () => {
    const m = parseFlowchart('flowchart TD\n  A ----> B\n  C o--o D')!;
    const e = edges(m);
    expect(serialize(setEdgeArrow(m, e[0], { head: 'cross' }))).toContain('A --x B');
    expect(serialize(setEdgeArrow(m, e[1], { stroke: 'thick' }))).toContain('C o==o D');
  });

  it('double from a single-ended edge writes <…>; invisible drops the label', () => {
    const m = parseFlowchart('flowchart TD\n  C -->|go| D')!;
    const e = edges(m);
    expect(serialize(setEdgeArrow(m, e[0], { head: 'double' }))).toContain('C <-->|go| D');
    expect(serialize(setEdgeArrow(m, e[0], { stroke: 'invisible' }))).toContain('C ~~~ D');
  });

  it('picking a head on an invisible edge lands back on a normal stroke', () => {
    const m = parseFlowchart('flowchart TD\n  A ~~~ B')!;
    expect(serialize(setEdgeArrow(m, edges(m)[0], { head: 'arrow' }))).toContain('A --> B');
  });
});

describe('setEdgeAnimate (M29.31)', () => {
  it('mints an id, writes it into the edge line, and appends the meta line', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B')!;
    expect(serialize(setEdgeAnimate(m, edges(m)[0], true))).toBe(
      'flowchart TD\n  A[Start] e1@--> B\n  e1@{ animate: true }',
    );
  });

  it('reuses an existing id and patches an existing meta line', () => {
    const m = parseFlowchart('flowchart TD\n  A e7@--> B\n  e7@{ curve: linear }')!;
    const out = serialize(setEdgeAnimate(m, edges(m)[0], true));
    expect(out).toContain('A e7@--> B');
    expect(out).toContain('e7@{ curve: linear, animate: true }');
  });

  it('off removes the entry, deletes an emptied line, and keeps the id', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animate: true }')!;
    expect(serialize(setEdgeAnimate(m, edges(m)[0], false))).toBe('flowchart TD\n  A e1@--> B');
  });

  it('off leaves a meta line with other keys in place', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animate: true, curve: basis }')!;
    const out = serialize(setEdgeAnimate(m, edges(m)[0], false));
    expect(out).toContain('e1@{ curve: basis }');
  });

  it('newEdgeId skips node and edge ids alike', () => {
    const m = parseFlowchart('flowchart TD\n  e1[X] e2@--> Y')!;
    expect(newEdgeId(m)).toBe('e3');
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/flowchart/`
Expected: FAIL — `--o`/`<-->`/`~~~` lines are opaque today; the new ops don't exist; `arrow` is still a string.

- [ ] **Step 3: Implement the model side**

**(a)** Replace the `Arrow` type and the `ARROWS` table with the structured surface:

```ts
export type EdgeStroke = 'normal' | 'thick' | 'dotted' | 'invisible';
export type EdgeHead = 'arrow' | 'open' | 'circle' | 'cross' | 'double';

/**
 * One edge's arrow (M29.31). `raw` is the verbatim source token and the
 * emission truth — an untouched segment re-emits its exact bytes even when a
 * line-mate goes dirty, and author-chosen lengths (`----->`) survive until
 * the segment itself is rewritten. `stroke`/`head` are the parsed reading;
 * `head: 'double'` covers <-->, o--o, and x--x, whose marker family lives in
 * `raw` (and is preserved by emitArrow on stroke-only rewrites).
 */
export interface EdgeArrow {
  stroke: EdgeStroke;
  head: EdgeHead;
  raw: string;
}

export const DEFAULT_ARROW: EdgeArrow = { stroke: 'normal', head: 'arrow', raw: '-->' };

const HEAD_BY_MARKER: Record<string, EdgeHead> = { '>': 'arrow', o: 'circle', x: 'cross' };
const DOUBLE_PAIR: Record<string, string> = { '<': '>', o: 'o', x: 'x' };

function classifyArrow(
  token: string,
  stroke: EdgeStroke,
  start: string | undefined,
  end: string | undefined,
  bodyLen: number,
): { token: string; stroke: EdgeStroke; head: EdgeHead } | null {
  if (start !== undefined && end !== undefined) {
    if (DOUBLE_PAIR[start] !== end) return null; // o--x, <--o … invalid upstream, not ours
    return { token, stroke, head: 'double' };
  }
  if (start !== undefined) return null; // a lone `<--` start is not a link
  if (end !== undefined) return { token, stroke, head: HEAD_BY_MARKER[end] };
  // No markers → open, which needs one body char beyond the minimum
  // (`---`, `===`; dotted's shortest form `-.-` is already open).
  if (stroke === 'dotted') return { token, stroke, head: 'open' };
  return bodyLen >= 3 ? { token, stroke, head: 'open' } : null;
}

/** Match one arrow token anchored at `i`, or null. Mirrors the v11.16.1 lexer's greediness. */
function matchArrow(
  text: string,
  i: number,
): { token: string; stroke: EdgeStroke; head: EdgeHead } | null {
  const slice = text.slice(i);
  let m = slice.match(/^([<ox])?(-{2,}|={2,})([>ox])?/);
  if (m !== null) {
    const stroke: EdgeStroke = m[2][0] === '=' ? 'thick' : 'normal';
    return classifyArrow(m[0], stroke, m[1], m[3], m[2].length);
  }
  m = slice.match(/^([<ox])?-(\.+)-([>ox])?/);
  if (m !== null) {
    return classifyArrow(m[0], 'dotted', m[1], m[3], m[2].length + 2);
  }
  m = slice.match(/^~{3,}/);
  if (m !== null) {
    return { token: m[0], stroke: 'invisible', head: 'open' };
  }
  return null;
}

/**
 * The minimum-length token for a stroke × head. `prevRaw` keeps an existing
 * o/x double family alive across rewrites; heads have no meaning on `~~~`.
 */
export function emitArrow(stroke: EdgeStroke, head: EdgeHead, prevRaw: string): string {
  if (stroke === 'invisible') return '~~~';
  const core = stroke === 'thick' ? '==' : stroke === 'dotted' ? '-.-' : '--';
  if (head === 'double') {
    const start = prevRaw.startsWith('o') || prevRaw.startsWith('x') ? prevRaw[0] : '<';
    return `${start}${core}${start === '<' ? '>' : start}`;
  }
  if (head === 'open') return stroke === 'dotted' ? core : `${core}${core[0]}`;
  const marker = head === 'arrow' ? '>' : head === 'circle' ? 'o' : 'x';
  return `${core}${marker}`;
}
```

**(b)** `EdgeSegment` and `EdgeEntry` grow (both changes are type-only for every existing consumer — `svgBinding` spreads `EdgeEntry`, `StructuralEditor` reads `label`):

```ts
export interface EdgeSegment {
  from: NodeRef[];
  to: NodeRef[];
  arrow: EdgeArrow;
  label: string | null;
  /** `A e1@--> B` — the id riding this segment's arrow, or null. */
  id: string | null;
}
```

```ts
export interface EdgeEntry {
  line: number;
  seg: number;
  from: string;
  to: string;
  arrow: EdgeArrow;
  label: string | null;
  id: string | null;
}
```

…and `edges()` passes `id: segment.id` through in its `out.push`.

**(c)** Rewrite `parseEdgeLine`'s scanner loop. The `Piece` interface becomes `{ text?: string; arrow?: EdgeArrow; label?: string | null; id?: string | null }`, and the arrow-hit branch becomes:

```ts
      const hit = matchArrow(trimmed, i);
      if (hit !== null) {
        // `A e1@--> B`: an edge id rides the arrow token (lexer [^\s"]+@).
        let text = cur;
        let id: string | null = null;
        const idMatch = text.match(/(?:^|\s)([^\s"]+)@$/);
        if (idMatch !== null) {
          id = idMatch[1];
          text = text.slice(0, text.length - id.length - 1);
        }
        pieces.push({ text });
        cur = '';
        i += hit.token.length;
        let label: string | null = null;
        if (trimmed[i] === '|') {
          const close = trimmed.indexOf('|', i + 1);
          if (close === -1) return null;
          label = trimmed.slice(i + 1, close);
          i = close + 1;
        }
        if (label !== null && hit.stroke === 'invisible') return null; // `~~~` carries no text
        pieces.push({ arrow: { stroke: hit.stroke, head: hit.head, raw: hit.token }, label, id });
        continue;
      }
```

The assembly loop's odd branch becomes:

```ts
    } else {
      const piece = pieces[p];
      if (piece.arrow === undefined) return null;
      arrows.push({ arrow: piece.arrow, label: piece.label ?? null, id: piece.id ?? null });
    }
```

(with `arrows` typed `{ arrow: EdgeArrow; label: string | null; id: string | null }[]`), and the segment builder adds `id: arrows[s].id`.

**(d)** In `parseLine`, replace the arrow-gate + call:

```ts
  if (ARROWS.some(([text]) => trimmed.includes(text))) {
    const segments = parseEdgeLine(trimmed);
    if (segments !== null) return { kind: 'edges', segments };
  }
```

with an unconditional attempt (the scanner is its own gate now; a line with no arrow yields one piece and returns null, falling through to the node-token attempt exactly as before):

```ts
  // parseEdgeLine is its own arbiter: no arrow, or any piece not fully ours,
  // → null, and the line falls through to the node-token attempt below.
  const segments = parseEdgeLine(trimmed);
  if (segments !== null) return { kind: 'edges', segments };
```

**(e)** `emitLine`'s `edges` case emits the raw token and the id prefix:

```ts
    case 'edges': {
      // Contiguous chains re-emit as chains; ops splits non-contiguous lines.
      let out = `${indent}${p.segments[0].from.map(emitNodeRef).join(' & ')}`;
      for (const seg of p.segments) {
        out += ` ${seg.id !== null ? `${seg.id}@` : ''}${seg.arrow.raw}${
          seg.label !== null ? `|${seg.label}|` : ''
        } ${seg.to.map(emitNodeRef).join(' & ')}`;
      }
      return out;
    }
```

**(f)** `nodes()` gains the edge-id exclusion promised in E1 — before the meta merge loop:

```ts
  // An id that names an edge (`A e1@--> B` + `e1@{ animate: true }`) is edge
  // meta, not a node. Mermaid resolves subgraph→edge→node; syntax alone
  // settles it for us.
  const edgeIds = new Set<string>();
  for (const line of model.lines) {
    if (line.parsed.kind !== 'edges') continue;
    for (const seg of line.parsed.segments) {
      if (seg.id !== null) edgeIds.add(seg.id);
    }
  }
```

…and the merge loop skips them: `if (edgeIds.has(id)) continue;`.

**(g)** The animation reader:

```ts
/** True when this edge's id has an `animate: true` meta entry. */
export function edgeAnimated(model: FlowchartModel, edge: EdgeEntry): boolean {
  if (edge.id === null) return false;
  const meta = nodeMeta(model).get(edge.id);
  return meta?.entries.some(([k, v]) => k === 'animate' && v === 'true') ?? false;
}
```

- [ ] **Step 4: Implement the ops side**

**(a)** `addEdge`'s pushed segment becomes `{ from: […], to: […], arrow: { ...DEFAULT_ARROW }, label: null, id: null }` (import `DEFAULT_ARROW` from `./model`).

**(b)** `rebuildEdgeLines`' survivor emission keeps each segment's arrow (raw included) and gives the segment's id to its **first** survivor only — a split that duplicated `e1@` onto several lines would collide upstream:

```ts
  const idUsed = new Set<number>();
  for (const pair of survivors) {
    const keepId = original[pair.seg].id !== null && !idUsed.has(pair.seg);
    idUsed.add(pair.seg);
    replacements.push({
      raw: indent,
      parsed: {
        kind: 'edges',
        segments: [
          {
            from: [pair.from],
            to: [pair.to],
            arrow: original[pair.seg].arrow,
            label: original[pair.seg].label,
            id: keepId ? original[pair.seg].id : null,
          },
        ],
      },
      dirty: true,
    });
  }
```

**(c)** The new ops (extend the `./model` import with `edges`, `emitArrow`, `nodeMeta`, and the `EdgeHead`/`EdgeStroke` types):

```ts
/**
 * Rewrite one segment's arrow (M29.31). Only that token changes: the rest of
 * the line re-emits from its own raws/labels, and a rewritten arrow
 * normalizes to minimum length (length is authorable in code, not here).
 * `~~~` can carry neither head nor label, so entering invisible drops the
 * label, and picking a head while invisible lands back on a normal stroke.
 */
export function setEdgeArrow(
  model: FlowchartModel,
  edge: EdgeEntry,
  patch: { stroke?: EdgeStroke; head?: EdgeHead },
): FlowchartModel {
  const next = clone(model);
  const line = next.lines[edge.line];
  if (line.parsed.kind !== 'edges') return next;
  const seg = line.parsed.segments[edge.seg];
  let stroke = patch.stroke ?? seg.arrow.stroke;
  const head = patch.head ?? seg.arrow.head;
  if (patch.head !== undefined && patch.stroke === undefined && stroke === 'invisible') {
    stroke = 'normal';
  }
  const raw = emitArrow(stroke, head, seg.arrow.raw);
  seg.arrow = { stroke, head: stroke === 'invisible' ? 'open' : head, raw };
  if (stroke === 'invisible') seg.label = null;
  line.dirty = true;
  return next;
}

/** `e1`-style id no existing node, edge, or meta id claims (case-insensitive, like newNodeId). */
export function newEdgeId(model: FlowchartModel): string {
  const used = new Set<string>();
  for (const id of nodes(model).keys()) used.add(id.toLowerCase());
  for (const entry of edges(model)) {
    if (entry.id !== null) used.add(entry.id.toLowerCase());
  }
  for (const id of nodeMeta(model).keys()) used.add(id.toLowerCase());
  let n = 1;
  while (used.has(`e${n}`)) n += 1;
  return `e${n}`;
}

/**
 * Toggle edge animation (M29.31). ON ensures the edge has an id (minting an
 * `eN` and writing it into the edge line when needed) and an
 * `id@{ animate: true }` meta line right below the edge. OFF removes only the
 * `animate` entry — the line too when that empties it — and leaves the id in
 * place: ids are cheap, other meta keys may depend on them, and removing more
 * than asked violates the surgical rule.
 */
export function setEdgeAnimate(
  model: FlowchartModel,
  edge: EdgeEntry,
  on: boolean,
): FlowchartModel {
  const next = clone(model);
  const line = next.lines[edge.line];
  if (line.parsed.kind !== 'edges') return next;
  const seg = line.parsed.segments[edge.seg];

  if (!on) {
    if (seg.id === null) return next;
    for (let i = next.lines.length - 1; i >= 0; i -= 1) {
      const parsed = next.lines[i].parsed;
      if (parsed.kind !== 'node-meta' || parsed.id !== seg.id) continue;
      const stripped = withMetaEntry(parsed.meta, 'animate', null);
      if (stripped.entries.length === 0) {
        next.lines.splice(i, 1);
      } else {
        parsed.meta = stripped;
        next.lines[i].dirty = true;
      }
    }
    return next;
  }

  let id = seg.id;
  if (id === null) {
    id = newEdgeId(next);
    seg.id = id;
    line.dirty = true;
  }
  for (const l of next.lines) {
    if (l.parsed.kind === 'node-meta' && l.parsed.id === id) {
      l.parsed.meta = withMetaEntry(l.parsed.meta, 'animate', 'true');
      l.dirty = true;
      return next;
    }
  }
  const indent = line.raw.match(/^\s*/)?.[0] ?? '  ';
  const at = next.lines.indexOf(line);
  next.lines.splice(at + 1, 0, {
    raw: indent,
    parsed: { kind: 'node-meta', id, meta: { entries: [['animate', 'true']] } },
    dirty: true,
  });
  return next;
}
```

- [ ] **Step 5: Run the whole mermaid suite; fix fallout, don't weaken proofs**

Run: `pnpm test:run src/mermaid/`
Expected: green. Existing Stage-C tests assert edge behavior through serialized strings and `toMatchObject({from,to,label})`, so the `arrow` type change should be invisible to them; if any test pinned an arrow *string*, update it to `expect.objectContaining({ raw: '-->' })` — never delete the assertion.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/
git commit -m "feat(mermaid): the full edge grammar — strokes, heads, ids, animation (M29.31)"
```

---

### Task E4: The shape registry + `ShapePalette` (M29.32)

The 8-icon strip becomes a searchable popover grid over **the full 49-shape registry** (resolved at review 2026-08-09 — spec §4.4), grouped Basic / Process / Technical / Annotation (our editorial grouping; upstream has none). `setNodeShape` widens per **D4**: a classic-8 target on a meta-less node still rewrites brackets (byte-compatible with Stage C); everything else patches/creates the node's `@{ shape: … }` line, brackets untouched (shape data wins at render). Every lucide icon name below was verified to resolve in the installed `lucide-react@^0.525.0`, and a test *keeps* that true via `resolveIcon`.

**Files:**
- Create: `src/mermaid/flowchart/shapes.ts`
- Create: `src/mermaid/flowchart/shapes.test.ts`
- Create: `src/mermaid/flowchart/ShapePalette.tsx`
- Create: `src/mermaid/flowchart/ShapePalette.test.tsx`
- Modify: `src/mermaid/flowchart/ops.ts` (+ `ops.test.ts`)
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx` (+ `StructuralEditor.test.tsx`)

- [ ] **Step 1: Write the failing tests**

Create `src/mermaid/flowchart/shapes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveIcon } from '@/components/ui/Icon';
import {
  BRACKET_SHAPE_TO_REGISTRY,
  PALETTE_SHAPES,
  REGISTRY_TO_BRACKET,
  SHAPE_ALIASES,
  VALID_SHAPES,
} from './shapes';

describe('shape registry (M29.32)', () => {
  it('every palette shape is a valid registry short name', () => {
    for (const s of PALETTE_SHAPES) expect(VALID_SHAPES.has(s.name), s.name).toBe(true);
  });

  it('every palette icon resolves to a real lucide glyph', () => {
    for (const s of PALETTE_SHAPES) expect(resolveIcon(s.icon).Comp, s.icon).not.toBeNull();
  });

  it('registry names are mermaid-legal: lowercase, no underscores', () => {
    for (const name of VALID_SHAPES) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('ellipse is excluded on purpose — broken upstream (mermaid#5976)', () => {
    expect(VALID_SHAPES.has('ellipse')).toBe(false);
  });

  it('the undocumented-but-working doublecircle alias is accepted', () => {
    expect(VALID_SHAPES.has('doublecircle')).toBe(true);
  });

  it('the classic 8 map to the registry and back', () => {
    for (const [bracket, registry] of Object.entries(BRACKET_SHAPE_TO_REGISTRY)) {
      expect(REGISTRY_TO_BRACKET[registry]).toBe(bracket);
      expect(VALID_SHAPES.has(registry)).toBe(true);
    }
  });

  it('the palette covers the ENTIRE registry — all 49 short names, four categories', () => {
    expect(PALETTE_SHAPES).toHaveLength(49);
    expect(new Set(PALETTE_SHAPES.map((s) => s.name))).toEqual(new Set(Object.keys(SHAPE_ALIASES)));
    expect(new Set(PALETTE_SHAPES.map((s) => s.category))).toEqual(
      new Set(['Basic', 'Process', 'Technical', 'Annotation']),
    );
  });
});
```

Create `src/mermaid/flowchart/ShapePalette.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShapePalette } from './ShapePalette';

describe('ShapePalette', () => {
  it('renders the four categories and picks a shape', async () => {
    const onPick = vi.fn();
    render(<ShapePalette current="rect" onPick={onPick} onClose={() => {}} />);
    expect(screen.getByText('Basic')).toBeTruthy();
    expect(screen.getByText('Process')).toBeTruthy();
    expect(screen.getByText('Technical')).toBeTruthy();
    expect(screen.getByText('Annotation')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Cloud' }));
    expect(onPick).toHaveBeenCalledWith('cloud');
  });

  it('marks the current shape', () => {
    render(<ShapePalette current="cloud" onPick={() => {}} onClose={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Shape: Cloud' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('search filters by name, label, and alias', async () => {
    render(<ShapePalette current={null} onPick={() => {}} onClose={() => {}} />);
    const search = screen.getByLabelText('Search shapes');
    await userEvent.type(search, 'database');
    expect(screen.getByRole('button', { name: 'Shape: Database' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Shape: Cloud' })).toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, 'terminal'); // stadium's registry alias
    expect(screen.getByRole('button', { name: 'Shape: Stadium' })).toBeTruthy();
  });
});
```

Append to `ops.test.ts`:

```ts
describe('setNodeShape — registry shapes (M29.32, D4)', () => {
  it('classic 8 without a meta line still rewrites brackets (Stage C behavior)', () => {
    const out = serialize(setNodeShape(model(), 'A', 'circle'));
    expect(out).toContain('A((Start)) --> B{Choice}');
  });

  it('an exotic shape writes a meta line after the node, brackets untouched', () => {
    const out = serialize(setNodeShape(model(), 'A', 'cloud'));
    expect(out).toContain('A[Start] --> B{Choice}');
    expect(out.split('\n')[2]).toBe('  A@{ shape: cloud }');
  });

  it('a classic-8 pick PATCHES the meta when a meta line exists', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B\n  A@{ shape: cloud }')!;
    const out = serialize(setNodeShape(m, 'A', 'diamond'));
    expect(out).toContain('A@{ shape: diam }');
    expect(out).toContain('A[Start] --> B');
  });

  it('registry aliases resolve to brackets where possible', () => {
    const out = serialize(setNodeShape(model(), 'A', 'database'));
    expect(out).toContain('A[(Start)] --> B{Choice}');
  });

  it('a name outside the registry is refused — mermaid would throw at render', () => {
    expect(serialize(setNodeShape(model(), 'A', 'blob'))).toBe(SRC);
  });
});
```

Append to `StructuralEditor.test.tsx` (inside the existing describe, using its `CODE`/fixture-svg mock):

```tsx
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
```

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/flowchart/`
Expected: FAIL — modules not found; `setNodeShape` rejects a string.

- [ ] **Step 3: Implement `src/mermaid/flowchart/shapes.ts`**

```ts
import type { Shape } from './model';

/**
 * The mermaid v11.16.1 shape registry (verified against the vendored source
 * at docs/examples/mermaid-develop in the main checkout). `ellipse` is
 * deliberately absent — broken upstream (mermaid#5976) — so we can never
 * write it. `doublecircle` works despite being undocumented. Aliases listed
 * are the verified subset; upstream accepts a few more per shape, but this
 * set only gates what WE write, and we only ever write short names — a
 * stricter set is strictly safe.
 */
export const SHAPE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  rect: ['proc', 'process', 'rectangle'],
  rounded: ['event'],
  stadium: ['terminal', 'pill'],
  'fr-rect': ['subproc', 'subroutine'],
  cyl: ['db', 'database'],
  circle: ['circ'],
  diam: ['decision', 'diamond', 'question'],
  hex: ['hexagon', 'prepare'],
  'lean-r': ['in-out'],
  'lean-l': ['out-in'],
  'trap-b': ['priority', 'trapezoid'],
  'trap-t': ['manual', 'inv-trapezoid'],
  'dbl-circ': ['double-circle', 'doublecircle'],
  text: [],
  'notch-rect': ['card'],
  'lin-rect': ['lined-process'],
  'sm-circ': ['start'],
  'fr-circ': ['stop'],
  fork: ['join'],
  hourglass: ['collate'],
  brace: ['comment'],
  'brace-r': [],
  braces: [],
  bolt: ['com-link'],
  doc: ['document'],
  delay: [],
  'h-cyl': ['das'],
  'lin-cyl': ['disk'],
  'curv-trap': ['display'],
  'div-rect': ['div-proc'],
  tri: ['extract'],
  'win-pane': ['internal-storage'],
  'f-circ': ['junction'],
  'notch-pent': ['loop-limit'],
  'flip-tri': ['manual-file'],
  'sl-rect': ['manual-input'],
  docs: ['st-doc'],
  'st-rect': ['procs'],
  'bow-rect': ['stored-data'],
  'cross-circ': ['summary'],
  'tag-doc': [],
  'tag-rect': ['tag-proc'],
  flag: ['paper-tape'],
  odd: [],
  'lin-doc': [],
  person: [],
  datastore: [],
  bang: [],
  cloud: [],
};

/** Every name setNodeShape may write or accept: short names + verified aliases. */
export const VALID_SHAPES: ReadonlySet<string> = new Set(
  Object.entries(SHAPE_ALIASES).flatMap(([name, aliases]) => [name, ...aliases]),
);

/** Classic bracket shape → the registry short name we write into `@{ shape }`. */
export const BRACKET_SHAPE_TO_REGISTRY: Readonly<Record<Shape, string>> = {
  rect: 'rect',
  rounded: 'rounded',
  stadium: 'stadium',
  circle: 'circle',
  diamond: 'diam',
  hexagon: 'hex',
  cylinder: 'cyl',
  subroutine: 'fr-rect',
};

/**
 * Any spelling (short name, alias, or bracket-shape literal) that denotes one
 * of the classic 8 → its bracket Shape, for D4's brackets-first path.
 */
export const REGISTRY_TO_BRACKET: Readonly<Record<string, Shape | undefined>> = (() => {
  const out: Record<string, Shape> = {};
  for (const [bracket, registry] of Object.entries(BRACKET_SHAPE_TO_REGISTRY)) {
    out[bracket] = bracket as Shape;
    out[registry] = bracket as Shape;
    for (const alias of SHAPE_ALIASES[registry] ?? []) out[alias] = bracket as Shape;
  }
  return out;
})();

export interface PaletteShape {
  /** Registry short name — what setNodeShape writes. */
  name: string;
  label: string;
  /** lucide icon (kebab-case), verified against lucide-react 0.525. */
  icon: string;
  category: 'Basic' | 'Process' | 'Technical' | 'Annotation';
}

/**
 * The palette shows the ENTIRE registry (D4, spec §4.4) — every short name in
 * SHAPE_ALIASES, one entry each; the covering test enforces set equality.
 * Categories are OUR editorial grouping — upstream has none. The three brace
 * comments share one lucide glyph on purpose (no single-brace icon exists);
 * their labels disambiguate.
 */
export const PALETTE_SHAPES: readonly PaletteShape[] = [
  // Basic
  { name: 'rect', label: 'Rectangle', icon: 'square', category: 'Basic' },
  { name: 'rounded', label: 'Rounded', icon: 'square-round-corner', category: 'Basic' },
  { name: 'stadium', label: 'Stadium', icon: 'rectangle-horizontal', category: 'Basic' },
  { name: 'circle', label: 'Circle', icon: 'circle', category: 'Basic' },
  { name: 'sm-circ', label: 'Small circle', icon: 'circle-small', category: 'Basic' },
  { name: 'dbl-circ', label: 'Double circle', icon: 'circle-dot', category: 'Basic' },
  { name: 'diam', label: 'Decision', icon: 'diamond', category: 'Basic' },
  { name: 'hex', label: 'Hexagon', icon: 'hexagon', category: 'Basic' },
  { name: 'tri', label: 'Triangle', icon: 'triangle', category: 'Basic' },
  { name: 'text', label: 'Text', icon: 'type', category: 'Basic' },
  { name: 'fr-circ', label: 'Stop', icon: 'circle-stop', category: 'Basic' },
  { name: 'f-circ', label: 'Junction', icon: 'dot', category: 'Basic' },
  { name: 'odd', label: 'Odd', icon: 'octagon', category: 'Basic' },
  // Process
  { name: 'fr-rect', label: 'Subprocess', icon: 'square-stack', category: 'Process' },
  { name: 'lin-rect', label: 'Lined process', icon: 'columns-2', category: 'Process' },
  { name: 'div-rect', label: 'Divided process', icon: 'panel-top', category: 'Process' },
  { name: 'notch-rect', label: 'Card', icon: 'credit-card', category: 'Process' },
  { name: 'trap-b', label: 'Priority', icon: 'dock', category: 'Process' },
  { name: 'trap-t', label: 'Manual operation', icon: 'hand', category: 'Process' },
  { name: 'lean-r', label: 'Input / output', icon: 'move-right', category: 'Process' },
  { name: 'lean-l', label: 'Output / input', icon: 'move-left', category: 'Process' },
  { name: 'hourglass', label: 'Collate', icon: 'hourglass', category: 'Process' },
  { name: 'fork', label: 'Fork / join', icon: 'git-fork', category: 'Process' },
  { name: 'delay', label: 'Delay', icon: 'timer', category: 'Process' },
  { name: 'notch-pent', label: 'Loop limit', icon: 'pentagon', category: 'Process' },
  { name: 'flip-tri', label: 'Manual file', icon: 'flip-vertical', category: 'Process' },
  { name: 'sl-rect', label: 'Manual input', icon: 'keyboard', category: 'Process' },
  { name: 'st-rect', label: 'Stacked process', icon: 'layers', category: 'Process' },
  { name: 'tag-rect', label: 'Tagged process', icon: 'tag', category: 'Process' },
  { name: 'flag', label: 'Paper tape', icon: 'flag', category: 'Process' },
  { name: 'bolt', label: 'Com link', icon: 'zap', category: 'Process' },
  // Technical
  { name: 'cyl', label: 'Database', icon: 'database', category: 'Technical' },
  { name: 'h-cyl', label: 'Direct access storage', icon: 'cylinder', category: 'Technical' },
  { name: 'lin-cyl', label: 'Disk storage', icon: 'hard-drive', category: 'Technical' },
  { name: 'doc', label: 'Document', icon: 'file-text', category: 'Technical' },
  { name: 'docs', label: 'Documents', icon: 'files', category: 'Technical' },
  { name: 'lin-doc', label: 'Lined document', icon: 'scroll-text', category: 'Technical' },
  { name: 'curv-trap', label: 'Display', icon: 'monitor', category: 'Technical' },
  { name: 'win-pane', label: 'Internal storage', icon: 'grid-2x2', category: 'Technical' },
  { name: 'cloud', label: 'Cloud', icon: 'cloud', category: 'Technical' },
  { name: 'person', label: 'Person', icon: 'user', category: 'Technical' },
  { name: 'datastore', label: 'Data store', icon: 'server', category: 'Technical' },
  { name: 'bow-rect', label: 'Stored data', icon: 'save', category: 'Technical' },
  { name: 'tag-doc', label: 'Tagged document', icon: 'file-badge', category: 'Technical' },
  { name: 'cross-circ', label: 'Summary', icon: 'circle-x', category: 'Technical' },
  { name: 'bang', label: 'Bang', icon: 'sparkles', category: 'Technical' },
  // Annotation
  { name: 'brace', label: 'Comment (left brace)', icon: 'braces', category: 'Annotation' },
  { name: 'brace-r', label: 'Comment (right brace)', icon: 'braces', category: 'Annotation' },
  { name: 'braces', label: 'Comment (both braces)', icon: 'braces', category: 'Annotation' },
];
```

- [ ] **Step 4: Widen `setNodeShape` in `ops.ts`**

Replace the whole function (imports gain `nodeMeta` — already imported in E3 — and the `shapes.ts` tables):

```ts
import { BRACKET_SHAPE_TO_REGISTRY, REGISTRY_TO_BRACKET, VALID_SHAPES } from './shapes';
```

```ts
/** The node's meta line index, creating an empty one after its anchor when absent. */
function ensureMetaLine(next: FlowchartModel, id: string): number {
  for (let i = 0; i < next.lines.length; i += 1) {
    const parsed = next.lines[i].parsed;
    if (parsed.kind === 'node-meta' && parsed.id === id) return i;
  }
  const at = anchorLineFor(next, id);
  const indent = next.lines[at]?.raw.match(/^\s*/)?.[0] ?? '  ';
  next.lines.splice(at + 1, 0, {
    raw: indent,
    parsed: { kind: 'node-meta', id, meta: { entries: [] } },
    dirty: true,
  });
  return at + 1;
}

/**
 * D4 shape strategy (M29.32). A classic-8 target on a node with NO meta line
 * rewrites brackets — exactly the Stage-C behavior, byte for byte. Everything
 * else patches (or creates) the node's `@{ shape }` meta line and leaves the
 * brackets alone: shape data wins at render, and rewriting a bracket pair
 * nobody asked about violates the surgical rule. Names outside the verified
 * registry are refused outright — mermaid throws a render error on them.
 */
export function setNodeShape(
  model: FlowchartModel,
  id: string,
  shape: Shape | string,
): FlowchartModel {
  const bracket = REGISTRY_TO_BRACKET[shape];
  if (bracket !== undefined && !nodeMeta(model).has(id)) {
    const withLabel = findLabelSite(model, id) === null ? renameNode(model, id, id) : clone(model);
    const site = findLabelSite(withLabel, id);
    if (site === null) return withLabel; // unreachable: rename just created a site
    site.ref.shape = bracket;
    if (site.ref.label === null) site.ref.label = id;
    withLabel.lines[site.line].dirty = true;
    return withLabel;
  }

  const registryName = BRACKET_SHAPE_TO_REGISTRY[shape as Shape] ?? shape;
  if (!VALID_SHAPES.has(registryName)) return clone(model);
  const next = clone(model);
  const idx = ensureMetaLine(next, id);
  const line = next.lines[idx];
  if (line.parsed.kind !== 'node-meta') return next;
  line.parsed.meta = withMetaEntry(line.parsed.meta, 'shape', registryName);
  line.dirty = true;
  return next;
}
```

- [ ] **Step 5: Implement `src/mermaid/flowchart/ShapePalette.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { PALETTE_SHAPES, SHAPE_ALIASES } from './shapes';

const CATEGORIES = ['Basic', 'Process', 'Technical', 'Annotation'] as const;

/**
 * The shape palette (M29.32): a searchable grid over the FULL 49-shape
 * registry (spec §4.4), grouped by our four categories, scrolling inside the
 * popover past its max height. Renders through the Popover primitive,
 * anchored to the node mini-toolbar it opens from (the nearest positioned
 * ancestor — Popover's documented default). Picking calls onPick with the
 * registry short name; the caller owns the op and the close.
 */
export function ShapePalette({
  current,
  onPick,
  onClose,
}: {
  /** Registry short name of the node's current shape, for the pressed state. */
  current: string | null;
  onPick: (shape: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return PALETTE_SHAPES;
    return PALETTE_SHAPES.filter(
      (s) =>
        s.name.includes(q) ||
        s.label.toLowerCase().includes(q) ||
        (SHAPE_ALIASES[s.name] ?? []).some((a) => a.includes(q)),
    );
  }, [query]);

  return (
    <Popover onClose={onClose} role="dialog" ariaLabel="Shape palette" className="w-60 p-2">
      <div data-testid="shape-palette" className="flex max-h-96 flex-col gap-1.5">
        <input
          autoFocus
          aria-label="Search shapes"
          placeholder="Search shapes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="w-full flex-none rounded border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800 outline-none focus:border-cortex-500"
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
        {CATEGORIES.map((cat) => {
          const inCat = visible.filter((s) => s.category === cat);
          if (inCat.length === 0) return null;
          return (
            <div key={cat}>
              <div className="px-0.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-n-400">
                {cat}
              </div>
              <div className="grid grid-cols-5 gap-0.5">
                {inCat.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    title={s.label}
                    aria-label={`Shape: ${s.label}`}
                    aria-pressed={current === s.name}
                    onClick={() => onPick(s.name)}
                    className={`flex items-center justify-center rounded border-0 p-1.5 hover:bg-n-50 ${
                      current === s.name ? 'bg-cortex-50' : 'bg-transparent'
                    }`}
                  >
                    <Icon name={s.icon} size={15} color="var(--n-600)" />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="px-1 py-2 text-xs text-n-400">No shapes match.</div>
        )}
        </div>
      </div>
    </Popover>
  );
}
```

- [ ] **Step 6: Swap the strip for the palette in `StructuralEditor.tsx`**

1. Delete the `SHAPE_CHOICES` constant and its `map` in the node toolbar; drop the now-unused `Shape` type import if nothing else uses it.
2. Imports gain `ShapePalette` and `BRACKET_SHAPE_TO_REGISTRY` (from `./shapes`); the `./model` import gains `nodes` (already there) — nothing else.
3. New state, next to the other popover state: `const [shapeOpen, setShapeOpen] = useState(false);` and add `setShapeOpen(false);` inside the existing close-on-`[code]`-change effect.
4. Where the shape buttons were, render one trigger; the palette mounts as a child of the toolbar (its absolutely-positioned div is the anchor Popover measures):

```tsx
            <button
              type="button"
              aria-label="Change shape"
              title="Change shape"
              onClick={() => setShapeOpen(true)}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="shapes" size={13} color="var(--n-600)" />
            </button>
            {shapeOpen && (
              <ShapePalette
                current={(() => {
                  const resolved = nodes(model).get(validSelected);
                  if (resolved === undefined) return null;
                  return resolved.metaShape ?? BRACKET_SHAPE_TO_REGISTRY[resolved.shape];
                })()}
                onPick={(name) => {
                  setShapeOpen(false);
                  if (validSelected !== null) apply(setNodeShape(model, validSelected, name));
                }}
                onClose={() => setShapeOpen(false)}
              />
            )}
```

- [ ] **Step 7: Run, lint, commit**

```bash
pnpm test:run src/mermaid/flowchart/ && pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/
git commit -m "feat(mermaid): a searchable shape palette writes brackets or shape data (M29.32)"
```

---

### Task E5: `NodeStyleMenu` + edge controls (M29.33)

Node toolbar gains a colors popover — fill / border / text rows, 12 token-derived swatches + clear each — writing through `setNodeStyle`. The edge editor gains an arrow-head cycle, a stroke picker (solid/thick/dotted), and an animate toggle riding the M29.31 ops.

Swatches are **literal light-ramp hexes** from `src/styles/tokens/colors.css`, not `var()` references and not theme-resolved at click time: mermaid text must render identically outside this app and in either theme, so the file gets portable bytes, chosen once.

**Files:**
- Create: `src/mermaid/flowchart/NodeStyleMenu.tsx`
- Create: `src/mermaid/flowchart/NodeStyleMenu.test.tsx`
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx` (+ `StructuralEditor.test.tsx`)

- [ ] **Step 1: Write the failing tests**

Create `src/mermaid/flowchart/NodeStyleMenu.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NodeStyleMenu, STYLE_SWATCHES } from './NodeStyleMenu';

describe('NodeStyleMenu', () => {
  it('offers 12 swatches per row across fill, border, and text', () => {
    render(<NodeStyleMenu current={{}} onPatch={() => {}} onClose={() => {}} />);
    expect(STYLE_SWATCHES).toHaveLength(12);
    for (const label of ['Fill', 'Border', 'Text']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /^Fill #/ })).toHaveLength(12);
  });

  it('a swatch patches its declaration; clear nulls it', async () => {
    const onPatch = vi.fn();
    render(
      <NodeStyleMenu current={{ fill: '#eef1fe' }} onPatch={onPatch} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Border #3d5bde' }));
    expect(onPatch).toHaveBeenCalledWith({ stroke: '#3d5bde' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear fill' }));
    expect(onPatch).toHaveBeenCalledWith({ fill: null });
  });

  it('marks the current color', () => {
    render(<NodeStyleMenu current={{ color: '#de3b4e' }} onPatch={() => {}} onClose={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Text #de3b4e' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
```

Append to `StructuralEditor.test.tsx`:

```tsx
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
```

(The `code` prop is test-controlled and never changes, so the popovers stay open between ops and each op computes from the same original model — each assertion expects a single op's result on `CODE`.)

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/flowchart/`
Expected: FAIL — module not found; buttons absent.

- [ ] **Step 3: Implement `src/mermaid/flowchart/NodeStyleMenu.tsx`**

```tsx
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';

/**
 * Light-ramp token hexes (src/styles/tokens/colors.css): the 50 tint and 500
 * strong of each of the six ramps. Literal on purpose — mermaid text is
 * portable, so the file gets fixed bytes, not var() references that only this
 * app could resolve (D5).
 */
export const STYLE_SWATCHES: readonly string[] = [
  '#f6f7fa', // n-50
  '#7e8699', // n-500
  '#eef1fe', // cortex-50
  '#3d5bde', // cortex-500
  '#f5f0fe', // synapse-50
  '#8250dc', // synapse-500
  '#e9f7f0', // success-50
  '#1f9d61', // success-500
  '#fcf3e1', // warn-50
  '#de8f0a', // warn-500
  '#fdedef', // danger-50
  '#de3b4e', // danger-500
];

const ROWS = [
  { key: 'fill', label: 'Fill' },
  { key: 'stroke', label: 'Border' },
  { key: 'color', label: 'Text' }, // mermaid's text-color key is `color`
] as const;

/**
 * Node color menu (M29.33): three declaration rows, 12 swatches + clear each,
 * every press one setNodeStyle patch — one style-line edit, one undo step.
 */
export function NodeStyleMenu({
  current,
  onPatch,
  onClose,
}: {
  /** The node's current style declarations (nodeStyle(model, id)). */
  current: Record<string, string>;
  onPatch: (patch: Record<string, string | null>) => void;
  onClose: () => void;
}) {
  return (
    <Popover onClose={onClose} role="dialog" ariaLabel="Node colors" className="p-2">
      <div data-testid="node-style-menu" className="flex flex-col gap-1.5">
        {ROWS.map((row) => (
          <div key={row.key} className="flex items-center gap-1">
            <span className="w-10 flex-none text-[11px] text-n-500">{row.label}</span>
            {STYLE_SWATCHES.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`${row.label} ${hex}`}
                aria-pressed={current[row.key] === hex}
                onClick={() => onPatch({ [row.key]: hex })}
                className={`h-4 w-4 flex-none rounded-sm border ${
                  current[row.key] === hex ? 'border-cortex-500' : 'border-n-200'
                }`}
                style={{ backgroundColor: hex }}
              />
            ))}
            <button
              type="button"
              aria-label={`Clear ${row.label.toLowerCase()}`}
              title={`Clear ${row.label.toLowerCase()}`}
              onClick={() => onPatch({ [row.key]: null })}
              className="rounded border-0 bg-transparent p-0.5 hover:bg-n-50"
            >
              <Icon name="eraser" size={12} color="var(--n-500)" />
            </button>
          </div>
        ))}
      </div>
    </Popover>
  );
}
```

- [ ] **Step 4: Wire the node toolbar and edge editor in `StructuralEditor.tsx`**

1. Imports: `NodeStyleMenu` from `./NodeStyleMenu`; the `./model` import gains `edgeAnimated`, `nodeStyle`, and `type EdgeHead`; the `./ops` import gains `setEdgeArrow`, `setEdgeAnimate`, `setNodeStyle`.
2. Module constants:

```tsx
const HEAD_CYCLE: EdgeHead[] = ['arrow', 'open', 'circle', 'cross', 'double'];
const HEAD_LABEL: Record<EdgeHead, string> = {
  arrow: 'Arrow',
  open: 'None',
  circle: 'Circle',
  cross: 'Cross',
  double: 'Both ways',
};
```

3. State `const [styleOpen, setStyleOpen] = useState(false);`, cleared in the `[code]` effect alongside `setShapeOpen(false)`.
4. In the node toolbar, next to the shape trigger:

```tsx
            <button
              type="button"
              aria-label="Node colors"
              title="Node colors"
              onClick={() => setStyleOpen(true)}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="palette" size={13} color="var(--n-600)" />
            </button>
            {styleOpen && (
              <NodeStyleMenu
                current={validSelected !== null ? nodeStyle(model, validSelected) : {}}
                onPatch={(patch) => {
                  setStyleOpen(false);
                  if (validSelected !== null) apply(setNodeStyle(model, validSelected, patch));
                }}
                onClose={() => setStyleOpen(false)}
              />
            )}
```

5. In the edge editor popover, after the label-input/delete row, add a controls row (the container becomes `flex-col`, existing row wrapped in its own `flex` div):

```tsx
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={`Arrow head: ${HEAD_LABEL[edgeEditor.edge.arrow.head]}`}
                title="Cycle arrow head"
                onClick={() => {
                  const cur = edgeEditor.edge.arrow.head;
                  const next = HEAD_CYCLE[(HEAD_CYCLE.indexOf(cur) + 1) % HEAD_CYCLE.length];
                  apply(setEdgeArrow(model, edgeEditor.edge, { head: next }));
                  setEdgeEditor(null);
                }}
                className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
              >
                {HEAD_LABEL[edgeEditor.edge.arrow.head]}
              </button>
              {(['normal', 'thick', 'dotted'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-label={`Stroke ${s === 'normal' ? 'solid' : s}`}
                  aria-pressed={edgeEditor.edge.arrow.stroke === s}
                  onClick={() => {
                    apply(setEdgeArrow(model, edgeEditor.edge, { stroke: s }));
                    setEdgeEditor(null);
                  }}
                  className={`rounded-md border border-n-200 px-1.5 py-0.5 text-xs hover:bg-n-50 ${
                    edgeEditor.edge.arrow.stroke === s ? 'bg-n-50 text-n-800' : 'bg-n-0 text-n-600'
                  }`}
                >
                  {s === 'normal' ? 'Solid' : s === 'thick' ? 'Thick' : 'Dotted'}
                </button>
              ))}
              <button
                type="button"
                aria-label="Animate edge"
                aria-pressed={edgeAnimated(model, edgeEditor.edge)}
                title="Animate edge"
                onClick={() => {
                  apply(setEdgeAnimate(model, edgeEditor.edge, !edgeAnimated(model, edgeEditor.edge)));
                  setEdgeEditor(null);
                }}
                className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
              >
                <Icon name="play" size={13} color="var(--n-600)" />
              </button>
            </div>
```

(Invisible stroke is parse-only — deliberately not offered in the UI; an invisible edge is unclickable in the svg anyway.)

- [ ] **Step 5: Run everything, lint, commit**

```bash
pnpm test:run src/mermaid/ && pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/
git commit -m "feat(mermaid): node colors and edge controls from the canvas (M29.33)"
```

---

### Task E6: e2e against real mermaid + the full gate (M29.34)

One new Playwright test drives the Systems map's first flowchart through the whole Stage-E loop in real Chromium: exotic shape from the palette → code shows `@{ shape: … }` and mermaid re-renders it; fill swatch → `style` line appears; edge animate → the edge line gains an id and the meta line follows. **The honest colored-node assertable is the code plus a clean re-render** (`mermaid-error` count 0, svg visible): the `style Idea fill:#…` line in the source is our contract, and a zero-error re-render proves real mermaid accepted and applied it — whereas asserting inline `fill` attributes deep in mermaid's svg would couple us to DOM privates that Stage C deliberately kept out of our contract (we bind by id scheme only, per `svgBinding.ts`).

**Files:**
- Modify: `e2e/diagrams.spec.ts` (fifth test)

- [ ] **Step 1: Write the e2e**

Append to `e2e/diagrams.spec.ts` (boot boilerplate copied from the M29.19 test above it):

```ts
// M29.29–.33: shapes, colors, and edge animation are surgical text edits that
// real mermaid accepts — the palette writes `@{ shape: … }`, the color menu a
// `style` line, and the animate toggle mints an edge id plus its meta line.
test('shapes, colors, and edge animation round-trip as surgical mermaid', async ({ page }) => {
  // Same chunk-load headroom as the tests above.
  test.setTimeout(60_000);

  // -- Boot (same as above) ---------------------------------------------
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
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });

  // -- Open the corpus doc through quick open ---------------------------
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpenInput = page.getByTestId('quick-open-input');
  await expect(quickOpenInput).toBeVisible();
  await quickOpenInput.fill('Systems map');
  const result = page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 20_000 });

  // -- Enter visual editing on the first (flowchart) block ---------------
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Exotic shape: Idea becomes a cloud through the palette -------------
  await page.locator('[id*="flowchart-Idea-"]').first().click();
  await page.getByRole('button', { name: 'Change shape' }).click();
  await page.getByLabel('Search shapes').fill('cloud');
  await page.getByRole('button', { name: 'Shape: Cloud' }).click();
  // Real mermaid re-renders the edited source without error — that is the
  // proof it accepted `@{ shape: cloud }`.
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(page.getByLabel('Mermaid source')).toHaveValue(/Idea@\{ shape: cloud \}/);
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Fill color: a style line appears and mermaid still renders ---------
  await page.locator('[id*="flowchart-Idea-"]').first().click();
  await page.getByRole('button', { name: 'Node colors' }).click();
  await page.getByRole('button', { name: 'Fill #eef1fe' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(page.getByLabel('Mermaid source')).toHaveValue(/style Idea fill:#eef1fe/);
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Edge animate: the edge gains an id and its meta line ---------------
  await page.locator('[id*="L_Idea_Build"]').first().click();
  await page.getByRole('button', { name: 'Animate edge' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show code' }).click();
  const source = page.getByLabel('Mermaid source');
  await expect(source).toHaveValue(/Idea\[Idea\] e1@--> Build\[Build\]/);
  await expect(source).toHaveValue(/e1@\{ animate: true \}/);

  // -- And the mock fs eventually holds all three edits -------------------
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md')), {
      timeout: 15_000,
    })
    .toContain('e1@{ animate: true }');
  const raw = await page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md'));
  expect(raw).toContain('Idea@{ shape: cloud }');
  expect(raw).toContain('style Idea fill:#eef1fe');
});
```

Verification notes for the implementer, not assumptions: the first block is `Idea[Idea] --> Build[Build] / Build --> Review{Choice…}` per `demo-vault/strategy/systems-map.md`, so `L_Idea_Build` names its first edge. If clicking the edge path proves flaky in Chromium (thin hit target), click with `{ force: true }` or dispatch on the path's bounding box center — but confirm the edge editor actually opened (`getByLabel('Edge label')`) before touching the animate button. If any assertion diverges from live behavior, fix the code or the plan's claim — never loosen the assertion to pass.

- [ ] **Step 2: Run the spec, then the full gate**

```bash
PORT=5273 pnpm e2e -- diagrams.spec.ts     # expected: 5 passed
pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage && PORT=5273 pnpm e2e \
  && (cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings)
```

Expected: all green, coverage ratchet intact (the model/ops additions are heavily tested — coverage should rise, never fall).

- [ ] **Step 3: Commit**

```bash
git add e2e/diagrams.spec.ts
git commit -m "test(mermaid): shapes, styles, and animated edges round-trip in e2e (M29.34)"
```

---

## Stage E exit criteria

- `id@{ … }` single-line meta parses into ordered, unknown-key-preserving `NodeMeta`; multi-line blocks and bracket+meta hybrids go opaque and survive byte-for-byte (unit-proven). `nodes()` reports meta shape/label truthfully; `renameNode` lands on a meta label when one would win at render.
- `style` lines parse; `setNodeStyle` patches exactly the named declarations, preserves unknown ones in order, deletes an emptied line, creates a missing one after its node, and refuses undeclared ids. `linkStyle`/`classDef`/`class`/`click` remain opaque and untouched.
- The full edge surface — every stroke × head, both-way `o--o`/`x--x`/`<-->` families, lengths, `~~~` — parses with verbatim `raw` tokens; a dirty line re-emits untouched segments byte-true. `setEdgeArrow` rewrites one token at minimum length; `setEdgeAnimate` mints/reuses `eN` ids and manages the `animate` meta entry surgically.
- The node toolbar opens a searchable palette over the full 49-shape registry (Basic/Process/Technical/Annotation, spec §4.4) whose picks follow D4, and a 12-swatch color menu writing portable hex `style` lines; the edge editor cycles heads, picks strokes, and toggles animation.
- e2e proves real mermaid v11.16.1 accepts everything we write (zero-error re-renders) and the edits land on the (mock) disk.
- Full gate green; coverage ratchet intact; ids never changed anywhere in this stage.
