# M29 Stage H — Whiteboard View: the Tenth View Kind (M29.45–M29.50)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `whiteboard` joins `VIEW_TYPES` as the tenth view kind — a tab on a List (or a Type screen) whose canvas is a `.mmd` file in the vault, created on first open, edited through the shared `FullScreenDiagramEditor`, with the view's own records placeable on the canvas as clickable chips bound through mermaid `click` lines.

**Architecture (spec D8):** The whiteboard is NOT a record layout. Its capability record declares exactly one new flag, `canvas`, which gates exactly one new Presentation key, `whiteboard: { file }` — a vault-relative path to the tab's `.mmd`. Records stay source-of-truth; the whiteboard stores only references (`click <nodeId> "<record path>"` lines Stage F taught the model to understand). "Whiteboard on any collection" is satisfied because every Collection holds Lists and every List can hold a whiteboard tab — the M10 invariant (Collections carry no views) stands.

**Spec:** `docs/superpowers/specs/2026-08-09-cerebro-m29-wave2-parity-design.md` (decisions D1, D2, D3, D8, D10).

**Stage dependencies — read before starting:**

- **Stage D (M29.24–.28) must be merged.** This plan consumes `FullScreenDiagramEditor` (`src/mermaid/FullScreenDiagramEditor.tsx`) by its spec contract: props `{ code, onChangeCode, title?, embedded? }`, pan/zoom hosted by `CanvasViewport` which exposes a transform context (`useCanvasTransform`). If D landed with different names, adapt the call sites in Tasks H2/H3 to what exists — the spec contract, not this plan's spelling, is authoritative.
- **Stage F (M29.35–.39) must be merged before Task H3.** H3 consumes the `click` line kind (`ParsedLine` member `{ kind: 'click'; id: string; target: string }`) and the `setNodeLink(model, id, target)` op. Tasks H1–H2 have no F dependency; if F is still in flight, land H1–H2, then wait.
- **Stage G (M29.40–.44) is independent.** The whiteboard seed degrades gracefully: if the manual-layout marker (`%% cerebro:layout manual`) is understood by the model at implementation time, new whiteboards seed with it; if G hasn't landed (or was deferred), they seed a plain `flowchart TD` and gain manual layout the day G ships. Task H2 Step 4 has the exact check.

---

## Read this first — repo traps that will bite you

1. **`pnpm test` is watch mode and never exits.** Always `pnpm test:run` (or `pnpm test:run <file>`).
2. **jsdom cannot render mermaid.** Real `mermaid.render` in vitest hangs or garbage-renders. Unit tests mock `@/mermaid/render` — and in this stage, usually the whole `@/mermaid/FullScreenDiagramEditor` (it drags in the render chain, CodeMirror-ish textareas, and Stage D's viewport). Only e2e (real Chromium) renders diagrams for real.
3. **No jest-dom.** `src/test/setup.ts` configures testing-library only. Assert with `toBeTruthy()` / `toBeNull()` / `.textContent` — `toBeInTheDocument()` does not exist here and will throw at runtime.
4. **Zero-warning lint** (`pnpm lint --max-warnings=0` is the policy), Prettier 100 cols single quotes (`pnpm format`), every `eslint-disable` carries a written reason in place.
5. **Serializers are allowlists — the silent-data-loss class.** `serializePresentation` (engine/views.ts) writes only the keys it names. A Presentation key added to the type but not to the serializer round-trips to NOTHING: the user configures a whiteboard, the file pointer is dropped on the next save, and the tab creates a fresh canvas forever. Same for `clonePresentation`: a shallow-copied `whiteboard` object would be SHARED between a tab and its duplicate — editing either's pointer edits both. Both edits are in Task H1 and both have tests; do not skip either.
6. **DiagramPage's keyed-flush discipline (M29.23).** The autosave machinery (debounce + unmount flush) is only correct because the host mounts the editing component KEYED on the file path — a path change must be a true unmount so the flush cleanup still closes over the dying file's bytes. Task H2 extracts this machinery into `useDiagramFile`; the keyed-mount requirement travels with it and `WhiteboardView` must honor it (`key={file}` on the canvas subtree). The regression test `DiagramPage.test.tsx` — "a navigation mid-debounce flushes to the OLD file and never touches the new one" — must pass UNCHANGED after the refactor. If it needs editing, the refactor is wrong.
7. **Store-layer error invariant:** actions never throw; they catch, `toast()`, and return null/false. The whiteboard's create-on-open follows the same shape (M29.6's `writeTextFile` idiom in `MermaidBlockView.tsx:33-42`).
8. **mock parity:** `src/lib/mockIpc.ts` already mirrors `write_text_file` (mockIpc.ts:513) — same `.mmd`-only allowlist, same stem dedupe, same knowledge guard. No IPC changes are needed in this stage; if you find yourself editing `ipc.ts`, stop and re-read the task.
9. **e2e:** `PORT=5273 pnpm e2e` — a stale HMR'd dev server on :5173 fails whole suites at boot. Boot blocks are copied verbatim from `e2e/collections.spec.ts` (distiller off, theme pinned light). The mock disk is `window.__cerebroMockFs`, a `Map<string, string>`.
10. **Commit hooks:** pre-commit lints, pre-push runs the full gate; **never `--no-verify`**. If a Write/Edit trips the security hook on file content (rare; usually shell-metacharacter-dense test fixtures), fall back to a `bash` heredoc (`cat > file <<'EOF'`) — never weaken the content to dodge the hook.
11. **Commits:** `type(scope): sentence (M29.<n>)`, one phase per commit where possible.
12. **Coverage ratchets only tighten** (`vite.config.ts`). Every new file here ships with tests in the same task.

## File structure (Stage H end state)

```
src/engine/types.ts            VIEW_TYPES + 'whiteboard'; Presentation.whiteboard
src/engine/views.ts            LAYOUT_LABEL, parseWhiteboard, serialize/clone additions
src/engine/views.test.ts       round-trip proof for the new key
src/views/viewKinds.ts         canvas flag, CAPABILITIES.whiteboard, KEY_NEEDS, NEVER_SEEDED
src/views/viewKinds.test.ts    registration + carry-over proofs for the tenth kind
src/views/WhiteboardView.tsx   the view: create-on-open, canvas, host bar, Add record
src/views/WhiteboardView.test.tsx
src/views/whiteboardBindings.ts       pure: click-line → Entry resolution, insert op
src/views/whiteboardBindings.test.ts
src/views/RecordChipOverlay.tsx       HTML chips over bound nodes, inside the plane
src/views/RecordChipOverlay.test.tsx
src/views/ViewCanvas.tsx       the 'whiteboard' arm + whiteboardHost prop
src/views/ViewCanvas.test.tsx  whiteboard faces
src/views/ViewTabs.tsx         stale docstring; NewViewForm grid 3→4 cols
src/views/ViewToolbar.tsx      stale "six views" comment
src/mermaid/useDiagramFile.ts  DiagramPage's autosave discipline, extracted
src/mermaid/FullScreenDiagramEditor.tsx  + optional `overlay` prop (ONE additive edit)
src/pages/DiagramPage.tsx      refactored onto useDiagramFile (tests unchanged)
src/pages/ListPage.tsx         passes whiteboardHost
src/pages/TypePage.tsx         passes whiteboardHost
src/app/viewActions.test.ts    seedView whiteboard sanity
e2e/collections.spec.ts        "six and only the six" fossil → ten-kind assertion
e2e/whiteboard.spec.ts         create tab → file on disk → add record → open record
```

No Rust changes. `write_text_file` already allowlists `.mmd`, creates nested directories, and dedupes stems (`src-tauri/src/vault/write.rs:266-291`, proven by its own test at write.rs:891 which writes into a `diagrams/` subfolder); the TS mock mirrors all of it (`src/lib/mockIpc.ts:513-533`). Task H6 verifies the cargo gate stays green with a clean `src-tauri` diff.

---

### Task H1: ViewType plumbing — the compiler tour (M29.45)

Adding a member to `VIEW_TYPES` breaks compilation at every registry the view system keeps: `CAPABILITIES` (`satisfies Record<ViewType, …>`, viewKinds.ts:150), `LAYOUT_LABEL` (`Record<ViewType, string>`, views.ts:610), and the `ViewCanvas` switch (return-type-enforced, ViewCanvas.tsx:126). Adding a key to `Presentation` breaks `KEY_NEEDS` (`satisfies Record<Exclude<keyof Presentation, SharedKey>, Capability>`, viewKinds.ts:269). This task walks every compile error to green and pins the two things the compiler cannot see: the parse/serialize/clone allowlists.

**Files:**
- Modify: `src/engine/types.ts`
- Modify: `src/engine/views.ts`
- Modify: `src/views/viewKinds.ts`
- Modify: `src/views/ViewCanvas.tsx`
- Create: `src/views/WhiteboardView.tsx` (stub — real body in H2)
- Modify: `src/views/viewKinds.test.ts`
- Modify: `src/engine/views.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/views/viewKinds.test.ts` (inside the existing `describe('view kind registration')` — and update its imports to add `isCanvas`):

```ts
  // --- M29.45: the tenth kind -----------------------------------------------

  it('whiteboard is registered, labeled, and offered', () => {
    const wb = viewKind('whiteboard');
    expect(wb.value).toBe('whiteboard');
    expect(wb.label).toBe('Whiteboard');
    expect(isCanvas('whiteboard')).toBe(true);
    expect(VIEW_SEGMENTS.some((s) => s.testId === 'view-switch-whiteboard')).toBe(true);
  });

  /**
   * A canvas kind draws a file, not records. Every record-layout capability
   * would be a control that changes nothing on its canvas — the calendar's
   * M16.3 bug, avoided by declaring nothing.
   */
  it('a canvas kind declares no record-layout capability', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.canvas !== true) continue;
      expect(kind.groupable).toBeUndefined();
      expect(kind.dated).toBeUndefined();
      expect(kind.cards).toBeUndefined();
      expect(kind.charted).toBeUndefined();
      expect(kind.blocks).toBeUndefined();
      expect(kind.tabular).toBeUndefined();
      expect(kind.chips).toBeUndefined();
    }
  });
```

Add `expect(isCanvas(kind.value)).toBe(kind.canvas === true);` to the existing `reads capabilities off the kind rather than comparing strings` loop (viewKinds.test.ts:63-79).

In the `carrying a presentation to a new kind (M16.29)` describe:

1. Add to the `everything` fixture (viewKinds.test.ts:164-189):

```ts
    whiteboard: { file: 'delivery/whiteboards/map.mmd' },
```

2. Add a row to the `forbidden` table in `writes no key the new kind cannot read` (viewKinds.test.ts:227-247). **The expectation is `false` for every kind, including whiteboard** — see `NEVER_SEEDED` in Step 4 for why the file pointer is identity, not preference:

```ts
        // NEVER carried — not even whiteboard→whiteboard. The file is the
        // tab's identity (M29.45); see NEVER_SEEDED in viewKinds.ts.
        ['whiteboard', false],
```

3. Add the named test:

```ts
  /**
   * The file pointer never seeds a new tab (M29.45). A whiteboard born from a
   * whiteboard must get its OWN canvas: carrying the pointer would aim two
   * tabs at one .mmd, and "new whiteboard" would silently mean "second door
   * to the first one". (Duplicate is different on purpose — it copies the
   * whole view, pointer included, the way a duplicated dashboard keeps its
   * blocks.)
   */
  it('never carries the whiteboard file pointer, even whiteboard-to-whiteboard', () => {
    const board: Presentation = {
      type: 'whiteboard',
      group: [],
      sort: [{ field: 'modifiedAt', dir: 'desc' }],
      columns: [],
      whiteboard: { file: 'delivery/whiteboards/map.mmd' },
    };
    expect(carryOver(board, 'whiteboard').whiteboard).toBeUndefined();
    expect(carryOver(board, 'table').whiteboard).toBeUndefined();
  });
```

Append to `src/engine/views.test.ts` (the `views` describe, near the other round-trip tests at views.test.ts:296-365):

```ts
  it('round-trips the whiteboard file pointer (M29.45)', () => {
    const yaml = [
      'name: Ops',
      'views:',
      '  - id: canvas',
      '    name: Canvas',
      '    presentation:',
      '      type: whiteboard',
      '      whiteboard:',
      '        file: delivery/whiteboards/canvas.mmd',
    ].join('\n');
    const list = parseListYaml('ops', yaml);
    const view = list.definition.views[0];
    expect(view.presentation.type).toBe('whiteboard');
    expect(view.presentation.whiteboard).toEqual({ file: 'delivery/whiteboards/canvas.mmd' });

    // The serializer is an ALLOWLIST — this line is the proof the key was
    // added to it, which is the failure mode that loses user data silently.
    const out = parseListYaml('ops', serializeList(list.definition));
    expect(out.definition.views[0].presentation.whiteboard).toEqual({
      file: 'delivery/whiteboards/canvas.mmd',
    });
  });

  it('drops a blank or malformed whiteboard pointer rather than storing it', () => {
    for (const bad of ['whiteboard: 7', 'whiteboard:\n        file: ""', 'whiteboard: {}']) {
      const yaml = `views:\n  - presentation:\n      type: whiteboard\n      ${bad}\n`;
      const list = parseListYaml('t', yaml);
      expect(list.definition.views[0].presentation.whiteboard).toBeUndefined();
    }
  });

  it('a null file pointer is never written to YAML', () => {
    const def = parseListYaml('t', 'views:\n  - presentation:\n      type: whiteboard\n').definition;
    const view = def.views[0];
    const withNull = {
      ...def,
      views: [
        { ...view, presentation: { ...view.presentation, whiteboard: { file: null } } },
      ],
    };
    expect(serializeList(withNull)).not.toContain('whiteboard');
  });

  it('clonePresentation deep-copies the whiteboard pointer', () => {
    const p: Presentation = {
      type: 'whiteboard',
      group: [],
      sort: [{ field: 'modifiedAt', dir: 'desc' }],
      columns: [],
      whiteboard: { file: 'a.mmd' },
    };
    const copy = clonePresentation(p);
    expect(copy.whiteboard).toEqual(p.whiteboard);
    expect(copy.whiteboard).not.toBe(p.whiteboard);
  });
```

(Extend the file's imports as needed: `clonePresentation` from `./views`, `Presentation` type from `./types`. Match the file's existing import blocks.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm test:run src/views/viewKinds.test.ts src/engine/views.test.ts`
Expected: FAIL — TypeScript errors first (`'whiteboard'` is not a `ViewType`), which is the point: the compiler is the first test.

- [ ] **Step 3: `src/engine/types.ts` — the array and the key**

Append to `VIEW_TYPES` (types.ts:302-312):

```ts
export const VIEW_TYPES = [
  'table',
  'list',
  'board',
  'calendar',
  'gantt',
  'timeline',
  'gallery',
  'chart',
  'dashboard',
  'whiteboard',
] as const;
```

Add to `Presentation` (types.ts:464-550), directly after the `dashboard?: DashboardSpec;` member:

```ts
  /**
   * The whiteboard's canvas (M29.45): a vault-relative `.mmd` path, created
   * on first open (spec D8). `file: null` is representable in memory — the
   * "not created yet" state the view acts on — but never written: the
   * serializer drops it, so a fresh tab's YAML carries no key about a file
   * that does not exist, the same stored-only-off-default rule every other
   * layout block follows.
   */
  whiteboard?: { file: string | null };
```

- [ ] **Step 4: `src/views/viewKinds.ts` — capability, catalog entry, key gate, seed gate**

Four edits.

**(a)** Add the flag to the `ViewKind` interface (after `blocks?: boolean;`, viewKinds.ts:73):

```ts
  /**
   * Draws a free-form CANVAS rather than records (M29.45): the tab's content
   * is a `.mmd` file it owns, so it gets no record-layout pages and exactly
   * one presentation key — `whiteboard`, the file pointer.
   *
   * Optional like every flag above it — the file's style is that absence IS
   * false, and only the kind that has a capability says so. The `satisfies`
   * on CAPABILITIES therefore demands nothing new from the existing nine
   * records: they stay byte-identical, and `isCanvas` reads `=== true`.
   */
  canvas?: boolean;
```

**(b)** Add the catalog entry after `dashboard` in `CAPABILITIES` (viewKinds.ts:142-149):

```ts
  whiteboard: {
    label: 'Whiteboard',
    // 'presentation' — the easel — verified present in lucide-react (as is
    // 'frame', the runner-up). NOT 'waypoints': the diagram surfaces claimed
    // that one (M29.21 page header, block header), and the distinct-icon
    // test below only defends uniqueness against other VIEW KINDS, not
    // against the rest of the app's iconography.
    icon: 'presentation',
    // Deliberately nothing else. Every record-layout capability would be a
    // control that changes nothing on a canvas — the calendar's M16.3 bug.
    canvas: true,
  },
```

**(c)** Add the reader beside its siblings (after `hasBlocks`, viewKinds.ts:231-233):

```ts
/** True for the layouts that draw a free-form canvas, not records (M29.45). */
export function isCanvas(type: ViewType): boolean {
  return viewKind(type).canvas === true;
}
```

**(d)** Add the key gate to `KEY_NEEDS` (viewKinds.ts:269-289) — the `satisfies` is already failing without it:

```ts
  whiteboard: 'canvas',
```

**(e)** Add `NEVER_SEEDED` above `carryOver` and thread it through (viewKinds.ts:309-318):

```ts
/**
 * Keys `carryOver` never copies, even to a kind that can read them (M29.45).
 *
 * `whiteboard.file` names a resource the TAB owns, not a preference about
 * drawing. Seeding it into a new tab would aim two tabs at one `.mmd`, so
 * "add a whiteboard" while standing on one would silently create a second
 * door to the same canvas instead of a new canvas. The new tab starts with
 * no pointer and creates its own file on first open.
 *
 * (Duplicate keeps the pointer on purpose — `duplicateView` copies the whole
 * view, and a copy that shows the same canvas is what "duplicate" says.
 * Layout-switching a tab away and back also keeps it: `onChangeLayout` swaps
 * only `type`, so a whiteboard demoted to a table and restored finds its
 * canvas where it left it.)
 */
const NEVER_SEEDED: ReadonlySet<string> = new Set(['whiteboard']);

export function carryOver(base: Presentation, type: ViewType): Presentation {
  const kind = viewKind(type);
  const kept = Object.fromEntries(
    Object.entries(base).filter(([key]) => {
      if (NEVER_SEEDED.has(key)) return false;
      const needs = KEY_NEEDS[key as keyof typeof KEY_NEEDS];
      return needs === undefined || kind[needs] === true;
    }),
  ) as Presentation;
  return { ...kept, type };
}
```

(Keep `carryOver`'s existing doc comment; only the body gains the `NEVER_SEEDED` line.)

- [ ] **Step 5: `src/engine/views.ts` — label, parse, serialize, clone**

Four edits.

**(a)** `LAYOUT_LABEL` (views.ts:610-620) — the `Record<ViewType, string>` is already failing:

```ts
  whiteboard: 'Whiteboard',
```

**(b)** Sub-parser, beside `parseChart`/`parseDashboard` (after views.ts:316):

```ts
/**
 * The whiteboard's file pointer (M29.45). Only a non-empty string is a
 * pointer; anything else — null, blank, a number, `{}` — parses as "not
 * created yet" (absent), so the serializer never has to remember a null.
 */
function parseWhiteboard(raw: unknown): Presentation['whiteboard'] | undefined {
  const obj = asRecord(raw);
  return typeof obj.file === 'string' && obj.file.trim() !== ''
    ? { file: obj.file.trim() }
    : undefined;
}
```

**(c)** In `parsePresentation` (views.ts:199-276): add `const whiteboard = parseWhiteboard(obj.whiteboard);` beside the other sub-parser calls (views.ts:202-205), and the spread beside the dashboard's (views.ts:260):

```ts
    ...(whiteboard !== undefined ? { whiteboard } : {}),
```

**(d)** In `serializePresentation` (views.ts:779-812), beside the dashboard line (views.ts:805). **This is the allowlist — the single line whose omission silently loses the canvas** (trap 5):

```ts
    // M29.45: written only once the file exists. A null pointer is the
    // in-memory "create me" state and carries no information worth storing.
    ...(p.whiteboard !== undefined && p.whiteboard.file !== null
      ? { whiteboard: { file: p.whiteboard.file } }
      : {}),
```

**(e)** In `clonePresentation` (views.ts:60-75), beside the gallery/chart/dashboard deep copies — same reason they exist (views.ts:66-73):

```ts
    ...(p.whiteboard !== undefined ? { whiteboard: { ...p.whiteboard } } : {}),
```

- [ ] **Step 6: `src/views/WhiteboardView.tsx` — the stub the switch arm needs**

The full view lands in H2; this stub fixes the PROPS CONTRACT now so `ViewCanvas` is edited once. The two faces it renders (unavailable, preparing) are final — H2 adds the canvas between them.

```tsx
import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';

/**
 * Where a whiteboard tab creates and finds its canvas file (M29.45).
 *
 * `folder` is the folder of the HOST'S OWN file — the `.list.yml`'s folder
 * for a List (which is the collection folder, or '' for a root-level List),
 * the Type doc's folder for a Type screen. The canvas lands in a
 * `whiteboards/` subfolder of it. `viewName` names the file.
 */
export interface WhiteboardHost {
  folder: string;
  viewName: string;
}

export interface WhiteboardViewProps {
  /** The view's own (filtered) records — what "Add record" offers. */
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** null = a surface that cannot host a canvas (a dashboard block). */
  host: WhiteboardHost | null;
  /** Persists the created file's path onto the view. */
  onPresentationChange?: (next: Presentation) => void;
}

/**
 * A whiteboard tab (M29.45, spec D8): a `.mmd` canvas owned by the view,
 * rendered through the shared full-screen editor. Stub in M29.45 — M29.46
 * adds create-on-open and the canvas; M29.47 adds record chips.
 */
export function WhiteboardView({ host }: WhiteboardViewProps) {
  if (host === null) {
    // A dashboard block reaches here (M29.48 wires the page hosts and leaves
    // the dashboard out): recursion aside, a whiteboard is an EDITOR, and a
    // 300px read-only tile of one would be a picture pretending to be a
    // canvas. `hasBlocks` guards view-in-view nesting; this face guards
    // canvas-in-block.
    return (
      <EmptyState
        icon="presentation"
        title="Whiteboards live on their list"
        description="Open the list to draw on this whiteboard — it can't be embedded in a dashboard."
        className="flex-1"
        data-testid="whiteboard-unavailable"
      />
    );
  }
  return (
    <EmptyState
      icon="presentation"
      title="Preparing canvas…"
      className="flex-1"
      data-testid="whiteboard-creating"
    />
  );
}
```

**Check `EmptyState`'s real props before writing** (`src/components/ui/EmptyState.tsx:5-16`): it takes `icon/title/description/action/compact/style/className` — it does NOT spread unknown props, so `data-testid` will not pass through. Wrap instead:

```tsx
    return (
      <div data-testid="whiteboard-unavailable" className="flex min-h-0 flex-1">
        <EmptyState icon="presentation" title="Whiteboards live on their list" ... />
      </div>
    );
```

Use the wrapper form for both faces (`whiteboard-unavailable`, `whiteboard-creating`).

- [ ] **Step 7: `src/views/ViewCanvas.tsx` — the arm and the host prop**

Add to `ViewCanvasProps` (ViewCanvas.tsx:27-76):

```ts
  /**
   * Where a whiteboard tab creates and finds its canvas file (M29.45). Only
   * the page-level hosts pass it (M29.48); a dashboard block does not, and
   * the whiteboard arm renders its "lives on a list" face instead.
   */
  whiteboardHost?: WhiteboardHost;
```

Import `WhiteboardView, type WhiteboardHost` from `@/views/WhiteboardView`, destructure `whiteboardHost` in the component signature, and add the arm (the return-type enforcement is currently a compile error — this closes it):

```tsx
    case 'whiteboard':
      return (
        <WhiteboardView
          entries={entries}
          presentation={presentation}
          schema={schema}
          host={whiteboardHost ?? null}
          onPresentationChange={onPresentationChange}
        />
      );
```

Note the detail-siblings registration (ViewCanvas.tsx:106-121) needs no change: a whiteboard's `entries` still flow through `buildRows`, and the panel stepping through the view's records is correct — they ARE the records this tab is about.

- [ ] **Step 8: Run the tests and the whole gate**

Run: `pnpm test:run src/views/viewKinds.test.ts src/engine/views.test.ts`
Expected: all pass, including every pre-existing test — the tenth kind must not disturb the nine.

Run: `pnpm test:run && pnpm typecheck && pnpm lint`
Expected: clean. Watch for: `ViewSettingsPanel` and `ViewTabs` compile untouched (they render from `VIEW_KINDS` — the tenth tile appears in every picker for free, which is the registry pattern doing its job). `e2e/` is not compiled by vitest; its stale assertions are Task H5's problem, on purpose.

- [ ] **Step 9: Commit**

```bash
git add src/engine/types.ts src/engine/views.ts src/engine/views.test.ts src/views/viewKinds.ts src/views/viewKinds.test.ts src/views/ViewCanvas.tsx src/views/WhiteboardView.tsx
git commit -m "feat(views): whiteboard is the tenth view kind — registry plumbing end to end (M29.45)"
```

---

### Task H2: `useDiagramFile` + the real WhiteboardView (M29.46)

Two moves, one honest refactor first: DiagramPage's autosave machinery (load-once, 500ms debounce, in-flight queue, unmount flush — DiagramPage.tsx:76-159) becomes `useDiagramFile(path)`, and DiagramPage is rebuilt on it with **zero test edits**. Then `WhiteboardView` uses the same hook: first open creates `<host.folder>/whiteboards/<slug>.mmd` via `writeTextFile`, persists the path through `onPresentationChange`, and renders `FullScreenDiagramEditor` (embedded) keyed on the file.

**Files:**
- Create: `src/mermaid/useDiagramFile.ts`
- Modify: `src/pages/DiagramPage.tsx`
- Modify: `src/views/WhiteboardView.tsx`
- Create: `src/views/WhiteboardView.test.tsx`

- [ ] **Step 1: Extract `src/mermaid/useDiagramFile.ts`**

This is a MOVE of DiagramPage.tsx:66-159's machinery, not a redesign. The code below is the extraction; diff it against the page while writing and keep every comment that explains a race.

```ts
import { useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/editor/NoteBodyEditor';
import { readNote, saveNote } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** How long a pause in editing waits before the source flushes to disk. */
const SAVE_DEBOUNCE_MS = 500;

export interface DiagramFile {
  /** null while loading; hosts only mount editors on real content. */
  code: string | null;
  /** The read failed — renamed, trashed, or unreadable. The tombstone signal. */
  loadFailed: boolean;
  saveState: SaveState;
  /** The one write channel: every edit — typed or structural — goes through here. */
  handleChange: (next: string) => void;
}

/**
 * A `.mmd` file's whole editing lifecycle (M29.46): read-once, debounce-save,
 * survive-unmount. Extracted verbatim from DiagramPage (M29.21) so the
 * whiteboard view (M29.46) edits its canvas with the identical discipline.
 *
 * THE KEYED-MOUNT CONTRACT (M29.23) TRAVELS WITH THIS HOOK: the component
 * calling it MUST be mounted `key={path}` by its host, so a path change is a
 * true unmount. The pending-debounce flush runs as an unmount cleanup, and
 * only a true unmount guarantees that cleanup still belongs to the file it
 * was editing — an unkeyed path change re-points `handleChange`'s refs at
 * the new file FIRST and then runs the old cleanup, which writes the old
 * file's bytes into the new one and drops the pending edit. App.tsx keys
 * DiagramPage; WhiteboardView keys its canvas subtree. Do not call this from
 * a component whose host does not key it.
 *
 * Content is RAW end-to-end: readNote/saveNote pass `.mmd` bytes through
 * verbatim, so mermaid's own `---` config header survives every save. No
 * external live-reload (DocPage's M17.4 reconcile problem, consciously
 * deferred): the file is read once per mount, and an outside edit wins or
 * loses on last-write like any plain editor.
 */
export function useDiagramFile(path: string): DiagramFile {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);

  const [code, setCode] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [loadFailed, setLoadFailed] = useState(false);

  // The save pipeline lives in refs so the debounce and the unmount flush
  // always see the newest source without re-arming effects per keystroke.
  const latest = useRef('');
  const timer = useRef<number | null>(null);
  const saving = useRef(false);
  const queued = useRef(false);

  const flushRef = useRef<() => Promise<void>>(async () => {});
  flushRef.current = async () => {
    if (vaultPath === null) return;
    if (saving.current) {
      // A save is already on the wire; run again with the newer bytes when
      // it lands rather than racing two writes to the same file.
      queued.current = true;
      return;
    }
    saving.current = true;
    setSaveState('saving');
    try {
      await saveNote(vaultPath, path, latest.current);
      saving.current = false;
      if (queued.current) {
        queued.current = false;
        await flushRef.current();
      } else {
        setSaveState('saved');
      }
    } catch {
      saving.current = false;
      queued.current = false;
      setSaveState('failed');
      toast("Couldn't save diagram");
    }
  };

  const handleChange = (next: string) => {
    latest.current = next;
    setCode(next);
    setSaveState('dirty');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  };

  // Load once per mount (the host's key makes a path change a fresh mount).
  // Only a FAILED READ sets the tombstone: a file the scanner has not
  // adopted yet still opens (files-first — the file is the truth).
  useEffect(() => {
    let cancelled = false;
    setCode(null);
    setSaveState('idle');
    setLoadFailed(false);
    if (vaultPath === null) return;
    void readNote(vaultPath, path)
      .then((raw) => {
        if (cancelled) return;
        latest.current = raw;
        setCode(raw);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, path]);

  // A pending debounce must not die with the host: flush it on unmount.
  // Safe only under the keyed-mount contract above.
  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void flushRef.current();
      }
    };
  }, []);

  return { code, loadFailed, saveState, handleChange };
}
```

- [ ] **Step 2: Rebuild `DiagramPage` on the hook — tests must not change**

In `src/pages/DiagramPage.tsx`:

1. Delete the extracted machinery: the `SAVE_DEBOUNCE_MS` const, the `code/saveState/loadFailed` state, the `latest/timer/saving/queued/flushRef` refs, `handleChange`, the load effect, and the unmount-flush effect (DiagramPage.tsx:30, 66-159). Drop the now-unused `readNote, saveNote` and `useUiStore` imports if nothing else in the file uses them (`toast` is only used by the save path — it moves into the hook).
2. Replace with:

```tsx
  const { code, loadFailed, saveState, handleChange } = useDiagramFile(selection.path);
```

3. The mode latch stays HERE (it is page policy, not file plumbing). The old code latched inside the read's `.then`; latch on the null→content transition instead — same moment, observed from outside:

```tsx
  const [mode, setMode] = useState<'visual' | 'code'>('code');
  // Latched once, when the file first arrives (the App.tsx key makes that
  // once-per-file): visual for flowcharts, code for everything else. Never
  // auto-promoted after — mid-keystroke source becoming flowchart-shaped
  // must not yank the textarea away (M29.21). The demotion safety net below
  // is unchanged.
  const latched = useRef(false);
  useEffect(() => {
    if (latched.current || code === null) return;
    latched.current = true;
    setMode(parseFlowchart(code) !== null ? 'visual' : 'code');
  }, [code]);
```

4. Everything else — the doc comment, tombstone JSX, title derivation, both panes — stays byte-identical. Update the component's doc comment to note the machinery now lives in `useDiagramFile` and the App.tsx key remains load-bearing.

> **Stage D note:** if Stage D's M29.27 already rebuilt DiagramPage onto `FullScreenDiagramEditor`, the page's body differs from the line numbers above but the autosave machinery is the same M29.21 code — extract it from wherever it now lives (page or editor host) and refactor that call site instead. The invariant is single-sourced autosave discipline, not a particular file shape.

- [ ] **Step 3: Prove the refactor with the UNCHANGED regression suite**

Run: `pnpm test:run src/pages/DiagramPage.test.tsx`
Expected: **all 8 pass with zero edits to the test file** — especially `a navigation mid-debounce flushes to the OLD file and never touches the new one` (DiagramPage.test.tsx:106), which is the M29.23 corruption fix pinning the keyed-unmount-flush semantics this refactor must preserve. If any assertion needs "updating", the extraction changed behavior: stop and fix the hook, not the test.

Commit the refactor on its own — a mechanical move reviews best alone:

```bash
git add src/mermaid/useDiagramFile.ts src/pages/DiagramPage.tsx
git commit -m "refactor(mermaid): DiagramPage's autosave discipline extracted as useDiagramFile (M29.46)"
```

- [ ] **Step 4: Write the failing WhiteboardView tests**

Create `src/views/WhiteboardView.test.tsx`. The full-screen editor is mocked (trap 2) — these tests are about the view's lifecycle, not the editor's:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Presentation } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { WhiteboardView } from './WhiteboardView';

vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({
  FullScreenDiagramEditor: ({ code }: { code: string }) => (
    <div data-testid="fake-editor">{code}</div>
  ),
}));

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

const base: Presentation = {
  type: 'whiteboard',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [],
};

const schema = { types: {}, resolveField: () => ({ raw: null, display: '', color: null, ghost: false, def: undefined }) };

describe('WhiteboardView', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('renders the unavailable face when it has no host (a dashboard block)', () => {
    render(
      <WhiteboardView entries={[]} presentation={base} schema={schema as never} host={null} />,
    );
    expect(screen.getByTestId('whiteboard-unavailable')).toBeTruthy();
  });

  it('first open creates the canvas file and persists its path', async () => {
    const onPresentationChange = vi.fn();
    render(
      <WhiteboardView
        entries={[]}
        presentation={base}
        schema={schema as never}
        host={{ folder: 'delivery', viewName: 'Launch map' }}
        onPresentationChange={onPresentationChange}
      />,
    );
    await waitFor(() =>
      expect(onPresentationChange).toHaveBeenCalledWith({
        ...base,
        whiteboard: { file: 'delivery/whiteboards/launch-map.mmd' },
      }),
    );
    expect(fs().get('delivery/whiteboards/launch-map.mmd')).toContain('flowchart TD');
  });

  it('a root-level list creates under whiteboards/ with no leading slash', async () => {
    const onPresentationChange = vi.fn();
    render(
      <WhiteboardView
        entries={[]}
        presentation={base}
        schema={schema as never}
        host={{ folder: '', viewName: 'Sketch' }}
        onPresentationChange={onPresentationChange}
      />,
    );
    await waitFor(() =>
      expect(onPresentationChange).toHaveBeenCalledWith({
        ...base,
        whiteboard: { file: 'whiteboards/sketch.mmd' },
      }),
    );
  });

  it('creates exactly once, even across re-renders', async () => {
    const onPresentationChange = vi.fn();
    const { rerender } = render(
      <WhiteboardView
        entries={[]}
        presentation={base}
        schema={schema as never}
        host={{ folder: 'delivery', viewName: 'Map' }}
        onPresentationChange={onPresentationChange}
      />,
    );
    rerender(
      <WhiteboardView
        entries={[]}
        presentation={base}
        schema={schema as never}
        host={{ folder: 'delivery', viewName: 'Map' }}
        onPresentationChange={onPresentationChange}
      />,
    );
    await waitFor(() => expect(onPresentationChange).toHaveBeenCalled());
    expect(onPresentationChange).toHaveBeenCalledTimes(1);
    expect([...fs().keys()].filter((k) => k.startsWith('delivery/whiteboards/'))).toHaveLength(1);
  });

  it('renders the editor over an existing file', async () => {
    fs().set('delivery/whiteboards/map.mmd', 'flowchart TD\n  a[Hello]\n');
    render(
      <WhiteboardView
        entries={[]}
        presentation={{ ...base, whiteboard: { file: 'delivery/whiteboards/map.mmd' } }}
        schema={schema as never}
        host={{ folder: 'delivery', viewName: 'Map' }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('fake-editor').textContent).toContain('a[Hello]'),
    );
  });

  it('a pointer at a missing file shows the tombstone with a fresh-canvas action', async () => {
    render(
      <WhiteboardView
        entries={[]}
        presentation={{ ...base, whiteboard: { file: 'delivery/whiteboards/gone.mmd' } }}
        schema={schema as never}
        host={{ folder: 'delivery', viewName: 'Map' }}
        onPresentationChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('whiteboard-tombstone')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Start a new canvas' })).toBeTruthy();
  });
});
```

**Before writing, verify two mock-backend facts** (adjust the tests to reality, not reality to the tests): (1) `readNote` in `mockIpc.ts` rejects for a path absent from the mock fs — that is what the tombstone test relies on; (2) `resetMockFs` + `openVault('/demo-vault')` is the established boot (copy `DiagramPage.test.tsx:23-34`, including any `renderMermaid` mock the vault open path needs — if `openVault` drags the render chain in, add the same `vi.mock('@/mermaid/render', …)` stub that file uses). Check the real shape of `Schema` for the `schema as never` cast — if a `buildSchema`-style test helper exists in sibling view tests (look at `ViewCanvas.test.tsx`'s fixtures), use that instead of a hand-rolled object.

- [ ] **Step 5: Run them to make sure they fail**

Run: `pnpm test:run src/views/WhiteboardView.test.tsx`
Expected: FAIL — the stub renders `whiteboard-creating` for every hosted case and creates nothing.

- [ ] **Step 6: Implement the real `WhiteboardView`**

Replace the stub's hosted branch (keep the H1 faces and props; the diff is the body):

```tsx
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';
import { writeTextFile } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { FullScreenDiagramEditor } from '@/mermaid/FullScreenDiagramEditor';
import { useDiagramFile } from '@/mermaid/useDiagramFile';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What a fresh canvas holds. A bare `flowchart TD` is a valid, empty mermaid
 * flowchart — the structural editor opens on it with its add-node
 * affordances and nothing else, which is what "blank whiteboard" means.
 *
 * STAGE G HANDSHAKE: if the manual-layout marker has landed (grep
 * `cerebro:layout` in src/mermaid/flowchart/model.ts — Stage G's pos-comment
 * kind), append `%% cerebro:layout manual\n` here so a whiteboard defaults
 * to free-drag, and delete this paragraph. If G is absent or was deferred,
 * ship the plain seed: existing whiteboards pick manual layout up from the
 * layout menu the day G lands, losing nothing.
 */
const WHITEBOARD_SEED = 'flowchart TD\n';

export function WhiteboardView({
  entries,
  presentation,
  schema,
  host,
  onPresentationChange,
}: WhiteboardViewProps) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const file = presentation.whiteboard?.file ?? null;
  // One creation per mount, held across the async gap. Without this, the
  // effect re-fires while writeTextFile is on the wire (rescan re-renders)
  // and the stem-dedupe turns one canvas into launch-map.mmd + -2 + -3.
  const creating = useRef(false);

  useEffect(() => {
    if (file !== null || host === null || creating.current) return;
    if (vaultPath === null || onPresentationChange === undefined) return;
    creating.current = true;
    void (async () => {
      try {
        // <host folder>/whiteboards/<view-name-slug>.mmd. `host.folder` is ''
        // for a root-level List — no collection folder — so the canvas lands
        // in a top-level whiteboards/ (M29.46's rule, mirrored in the tests).
        const stem = slugify(host.viewName) || 'whiteboard';
        const rel = `${host.folder === '' ? '' : `${host.folder}/`}whiteboards/${stem}.mmd`;
        const actual = await writeTextFile(vaultPath, rel, WHITEBOARD_SEED);
        await rescan();
        // The pointer is presentation state, so it persists through the same
        // channel every view setting does — one write to the List's YAML.
        onPresentationChange({ ...presentation, whiteboard: { file: actual } });
      } catch (err) {
        creating.current = false;
        toast(`Couldn't create whiteboard: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    // presentation/onPresentationChange are read at fire time; keying the
    // effect on them would re-arm it per keystroke elsewhere in the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, host, vaultPath]);

  if (host === null) {
    return (/* unavailable face from H1, unchanged */);
  }
  if (file === null) {
    return (/* creating face from H1, unchanged */);
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="whiteboard-view">
      {/* KEYED on the file (trap 6): the canvas's useDiagramFile flushes on
          unmount, and only a true unmount keeps that flush aimed at the file
          it was editing. Re-pointing the tab at a new file must remount. */}
      <WhiteboardCanvas
        key={file}
        file={file}
        entries={entries}
        schema={schema}
        presentation={presentation}
        onPresentationChange={onPresentationChange}
        viewName={host.viewName}
      />
    </div>
  );
}

function WhiteboardCanvas({
  file,
  entries,
  schema,
  presentation,
  onPresentationChange,
  viewName,
}: {
  file: string;
  entries: Entry[];
  schema: Schema;
  presentation: Presentation;
  onPresentationChange?: (next: Presentation) => void;
  viewName: string;
}) {
  const { code, loadFailed, saveState, handleChange } = useDiagramFile(file);

  if (loadFailed) {
    // The pointer outlived its file: renamed folder, trashed file, hand-edited
    // YAML. Nothing in the app rewrites path references inside files on a
    // folder rename (navStore remaps SELECTIONS only — navStore.ts:34 — and
    // dashboard blocks' `collection` refs share this exact exposure), so this
    // face is the honest recovery: keep the dead pointer visible, offer a
    // fresh canvas. "Start a new canvas" clears the pointer to the in-memory
    // null state, which re-arms create-on-open.
    return (
      <div data-testid="whiteboard-tombstone" className="flex min-h-0 flex-1">
        <EmptyState
          icon="file-x"
          title="This whiteboard's file is gone"
          description={`${file} was renamed, moved, or deleted outside this tab.`}
          action={
            onPresentationChange && (
              <Button
                variant="secondary"
                onClick={() =>
                  onPresentationChange({ ...presentation, whiteboard: { file: null } })
                }
              >
                Start a new canvas
              </Button>
            )
          }
        />
      </div>
    );
  }
  if (code === null) {
    return <div data-testid="whiteboard-loading" className="flex-1" aria-busy="true" />;
  }
  return (
    <FullScreenDiagramEditor
      code={code}
      onChangeCode={handleChange}
      title={viewName}
      embedded
    />
  );
}
```

Unused-var notes for this step: `entries`/`schema`/`saveState` are threaded now and consumed in H3 (record chips + host bar) — if the linter objects before H3 lands, prefix the destructuring with the H3 wiring pulled forward (the Add-record bar shell) over a suppression. `WhiteboardViewProps`/`WhiteboardHost` stay exported (ViewCanvas imports the type).

- [ ] **Step 7: Run the tests and make sure they pass**

Run: `pnpm test:run src/views/WhiteboardView.test.tsx src/pages/DiagramPage.test.tsx src/views/viewKinds.test.ts`
Expected: all pass. Then `pnpm typecheck && pnpm lint`.

- [ ] **Step 8: Commit**

```bash
git add src/views/WhiteboardView.tsx src/views/WhiteboardView.test.tsx
git commit -m "feat(views): a whiteboard tab creates and edits its own .mmd canvas (M29.46)"
```

---

### Task H3: Record cards — bound nodes, chip overlay, Add record (M29.47)

**Depends on Stage F being merged** (the `click` line kind and `setNodeLink`). A node is "bound" when the model carries a `click <nodeId> "<target>"` line whose target resolves to a vault entry. Bound nodes get an HTML chip (title + status `FieldChip`) drawn over the node's bbox INSIDE the canvas plane; clicking a chip opens the record in-place (detail panel, M9.3). The whiteboard's host bar gains "Add record": a picker over the view's own entries that inserts a titled node plus its click binding in ONE code commit (one undo step — spec D10).

**Files:**
- Create: `src/views/whiteboardBindings.ts`
- Create: `src/views/whiteboardBindings.test.ts`
- Create: `src/views/RecordChipOverlay.tsx`
- Create: `src/views/RecordChipOverlay.test.tsx`
- Modify: `src/mermaid/FullScreenDiagramEditor.tsx` (ONE additive prop — see Step 3)
- Modify: `src/views/WhiteboardView.tsx`
- Modify: `src/views/WhiteboardView.test.tsx`

- [ ] **Step 1: Write the failing tests for the pure layer**

Create `src/views/whiteboardBindings.test.ts`. Entry fixtures follow the scanner shape (see any sibling view test for the minimal `Entry` literal — copy its helper if one exists rather than hand-rolling):

```ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { insertRecordNode, recordBindings, resolveBinding } from './whiteboardBindings';

/** Minimal scanner-shaped entry. Match the real Entry type — check a sibling
 * test's fixture and reuse its helper if one exists. */
const entry = (path: string, title: string): Entry =>
  ({
    path,
    filename: path.split('/').pop() ?? path,
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    title,
    type: 'Work item',
    properties: {},
    relationships: {},
  }) as Entry;

const ENTRIES = [
  entry('delivery/ship-v2.md', 'Ship v2'),
  entry('delivery/beta.md', 'Beta program'),
];

describe('resolveBinding', () => {
  it('resolves an exact vault path first', () => {
    expect(resolveBinding('delivery/ship-v2.md', ENTRIES)?.title).toBe('Ship v2');
  });
  it('falls back to wikilink resolution for hand-authored targets', () => {
    // resolveTarget's stem pass: `ship-v2` names delivery/ship-v2.md.
    expect(resolveBinding('ship-v2', ENTRIES)?.title).toBe('Ship v2');
  });
  it('a URL or unknown target binds nothing', () => {
    expect(resolveBinding('https://example.com', ENTRIES)).toBeNull();
    expect(resolveBinding('nope/missing.md', ENTRIES)).toBeNull();
  });
});

describe('recordBindings', () => {
  it('maps bound node ids to their entries and skips unresolved clicks', () => {
    const code = [
      'flowchart TD',
      '  a[Ship v2]',
      '  b[Elsewhere]',
      '  click a "delivery/ship-v2.md"',
      '  click b "https://example.com"',
    ].join('\n');
    const map = recordBindings(code, ENTRIES);
    expect(map.get('a')?.title).toBe('Ship v2');
    expect(map.has('b')).toBe(false);
  });

  it('returns empty for source that is not a flowchart', () => {
    expect(recordBindings('sequenceDiagram\n  A->>B: x', ENTRIES).size).toBe(0);
  });
});

describe('insertRecordNode', () => {
  it('adds a titled node and its click binding in one new source', () => {
    const next = insertRecordNode('flowchart TD\n', ENTRIES[0]);
    expect(next).not.toBeNull();
    // The node carries the record's title as its label…
    expect(next).toContain('Ship v2');
    // …and the binding line carries the vault path.
    expect(next).toContain('click');
    expect(next).toContain('delivery/ship-v2.md');
    // The result re-parses and the binding resolves — the round trip is the contract.
    expect([...recordBindings(next as string, ENTRIES).values()][0]?.path).toBe(
      'delivery/ship-v2.md',
    );
  });

  it('opaque source (not a flowchart) inserts nothing', () => {
    expect(insertRecordNode('gantt\n  title x', ENTRIES[0])).toBeNull();
  });
});
```

- [ ] **Step 2: Implement `src/views/whiteboardBindings.ts`**

```ts
import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { parseFlowchart, serialize } from '@/mermaid/flowchart/model';
import { addNode, setNodeLink } from '@/mermaid/flowchart/ops';

/**
 * Record binding (M29.47, spec D8): a whiteboard node is "bound" when the
 * model carries a `click <id> "<target>"` line (Stage F's understood kind)
 * whose target names a vault entry. The whiteboard stores only the
 * reference — records stay source-of-truth.
 */

/**
 * Exact vault path first — that is what "Add record" writes — then the
 * wikilink resolver (stem → project folder → title), so a hand-authored
 * `click a "ship-v2"` binds too. A URL or unknown target resolves to null
 * and the click line keeps meaning what mermaid means by it: a link.
 */
export function resolveBinding(target: string, entries: Entry[]): Entry | null {
  const exact = entries.find((e) => e.path === target);
  if (exact !== undefined) return exact;
  return resolveTarget(target, entries);
}

/** Every bound node in `code`: node id → the entry its click line names. */
export function recordBindings(code: string, entries: Entry[]): Map<string, Entry> {
  const map = new Map<string, Entry>();
  const model = parseFlowchart(code);
  if (model === null) return map;
  for (const line of model.lines) {
    if (line.parsed === null || line.parsed.kind !== 'click') continue;
    const hit = resolveBinding(line.parsed.target, entries);
    if (hit !== null) map.set(line.parsed.id, hit);
  }
  return map;
}

/**
 * "Add record": a node labeled with the record's title plus its click
 * binding — TWO model ops, ONE serialize, so the whole insertion is one
 * `onChangeCode` and one undo step (spec D10). Null when the source is not
 * an editable flowchart (the same opacity rule every structural op obeys).
 */
export function insertRecordNode(code: string, target: Entry): string | null {
  const model = parseFlowchart(code);
  if (model === null) return null;
  const added = addNode(model, target.title);
  const linked = setNodeLink(added.model, added.id, target.path);
  return serialize(linked);
}
```

**Stage F contract check while writing:** `ParsedLine`'s click member is `{ kind: 'click'; id: string; target: string }` and the op is `setNodeLink(model, id, target)` (spec D3/D8; `addNode` returns `{ model, id }` — that part is already real, ops.ts:83). If F landed the op under another name or shape (`grep -n "click\|NodeLink" src/mermaid/flowchart/ops.ts src/mermaid/flowchart/model.ts`), follow F's spelling and update this file AND the `line.parsed` access — `ModelLine.parsed`'s nullability is whatever model.ts declares (check `ModelLine`, model.ts:39, and drop the `!== null` guard if it is not nullable).

Run: `pnpm test:run src/views/whiteboardBindings.test.ts` — Expected: all pass.

- [ ] **Step 3: One additive edit to the shared editor — the `overlay` slot**

The chips must render INSIDE `CanvasViewport`'s transformed plane: that is where the transform context lives (spec D2 — "the structural editor's host, ghost line, toolbars, and record-chip overlays all render INSIDE the transformed plane so coordinates stay honest"). The Stage D contract `{ code, onChangeCode, title?, embedded? }` has no slot for a host-supplied plane child, so Stage H adds exactly one optional prop to `src/mermaid/FullScreenDiagramEditor.tsx`:

```tsx
  /**
   * Host-supplied layer rendered inside the canvas plane, above the diagram
   * (M29.47): the whiteboard's record chips. Inside the plane on purpose —
   * that is where useCanvasTransform is readable and where pan/zoom applies
   * without any coordinate math in the host.
   */
  overlay?: React.ReactNode;
```

Render it as the LAST child of the same transformed element the diagram svg lives in (position it `absolute inset-0` so it stacks over the render without displacing it). This is Stage H's only edit to a Stage D file; keep the diff to the prop, its render line, and the comment. Add one test beside the editor's existing ones proving `overlay` content renders (and does not render when omitted) — follow the mocking pattern `FullScreenDiagramEditor`'s own test file established in Stage D.

- [ ] **Step 4: Write the failing overlay tests**

Create `src/views/RecordChipOverlay.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { RecordChipOverlay } from './RecordChipOverlay';

// The svg binding needs a real layout engine; jsdom has none. Fabricate the
// binding: one bound node element whose rect we control.
const fakeNodeEl = () => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  el.getBoundingClientRect = () =>
    ({ left: 40, top: 20, width: 120, height: 48, right: 160, bottom: 68 }) as DOMRect;
  return el as SVGGElement;
};
vi.mock('@/mermaid/flowchart/svgBinding', () => ({
  bindFlowchartSvg: vi.fn(() => ({ nodeEls: new Map([['a', fakeNodeEl()]]), edgeEls: [] })),
}));
vi.mock('@/mermaid/CanvasViewport', () => ({
  useCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
}));
const open = vi.fn();
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));

const entry = {
  path: 'delivery/ship-v2.md',
  filename: 'ship-v2.md',
  folder: 'delivery',
  title: 'Ship v2',
  type: 'Work item',
  properties: {},
  relationships: {},
} as unknown as Entry;

const schema = {
  resolveField: () => ({ raw: 'doing', display: 'Doing', color: 'blue', ghost: false, def: { kind: 'status' } }),
} as never;

const CODE = 'flowchart TD\n  a[Ship v2]\n  click a "delivery/ship-v2.md"\n';

describe('RecordChipOverlay', () => {
  afterEach(() => {
    cleanup();
    open.mockReset();
  });

  it('draws a chip for each bound node, titled and status-badged', async () => {
    render(<RecordChipOverlay code={CODE} entries={[entry]} schema={schema} />);
    const chip = await screen.findByTestId('whiteboard-record-chip');
    expect(chip.textContent).toContain('Ship v2');
    expect(chip.textContent).toContain('Doing');
  });

  it('clicking a chip opens the record in place', async () => {
    render(<RecordChipOverlay code={CODE} entries={[entry]} schema={schema} />);
    await userEvent.click(await screen.findByTestId('whiteboard-record-chip'));
    expect(open).toHaveBeenCalledWith('delivery/ship-v2.md');
  });

  it('draws nothing when no click line binds', async () => {
    render(<RecordChipOverlay code={'flowchart TD\n  a[Loose]\n'} entries={[entry]} schema={schema} />);
    await waitFor(() => expect(screen.queryByTestId('whiteboard-record-chip')).toBeNull());
  });
});
```

Run: `pnpm test:run src/views/RecordChipOverlay.test.tsx` — Expected: FAIL, module not found.

- [ ] **Step 5: Implement `src/views/RecordChipOverlay.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import type { Entry, Schema } from '@/engine/types';
import { useCanvasTransform } from '@/mermaid/CanvasViewport';
import { parseFlowchart } from '@/mermaid/flowchart/model';
import { bindFlowchartSvg } from '@/mermaid/flowchart/svgBinding';
import { FieldChip } from '@/views/FieldChip';
import { recordBindings } from '@/views/whiteboardBindings';

interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Record chips over bound whiteboard nodes (M29.47, spec D8).
 *
 * Rendered INSIDE CanvasViewport's transformed plane (the editor's `overlay`
 * slot), so pan and zoom move the chips for free — the only math here is
 * converting each node's screen rect into plane-local units, which is a
 * subtraction and a divide by the current scale.
 *
 * MEASUREMENT MODEL: node positions come from the DOM (`bindFlowchartSvg` +
 * getBoundingClientRect), and the DOM changes on every mermaid re-render —
 * which is async and outside this component's control. So measurement re-runs
 * on (a) code changes, (b) transform changes (fit-to-content re-lays-out the
 * plane), and (c) a MutationObserver on the plane catching the svg swap that
 * follows every render. Until the svg for the CURRENT code exists, stale
 * rects are cleared rather than shown — a chip floating over yesterday's
 * layout is worse than a chip that arrives a frame late.
 */
export function RecordChipOverlay({
  code,
  entries,
  schema,
}: {
  code: string;
  entries: Entry[];
  schema: Schema;
}) {
  const open = useOpenPath('in-place');
  const transform = useCanvasTransform();
  const rootRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<Map<string, NodeRect>>(new Map());

  const bound = useMemo(() => recordBindings(code, entries), [code, entries]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const plane = root?.parentElement ?? null;
    if (root === null || plane === null || bound.size === 0) {
      setRects(new Map());
      return;
    }
    const model = parseFlowchart(code);
    if (model === null) {
      setRects(new Map());
      return;
    }
    const binding = bindFlowchartSvg(plane, model);
    const base = root.getBoundingClientRect();
    const scale = transform.scale;
    const next = new Map<string, NodeRect>();
    for (const [id, el] of binding.nodeEls) {
      if (!bound.has(id)) continue;
      const r = el.getBoundingClientRect();
      next.set(id, {
        x: (r.left - base.left) / scale,
        y: (r.top - base.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      });
    }
    setRects(next);
  }, [code, bound, transform]);

  // (a) + (b): re-measure when code or the viewport transform changes.
  useEffect(() => {
    measure();
  }, [measure]);

  // (c): re-measure when the plane's DOM mutates — the async render landing.
  useEffect(() => {
    const plane = rootRef.current?.parentElement;
    if (plane == null) return;
    const observer = new MutationObserver(() => measure());
    observer.observe(plane, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [measure]);

  return (
    // pointer-events-none on the layer, auto on each chip: the layer must
    // never eat the canvas's own drag/click surface between chips.
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      {[...rects.entries()].map(([id, rect]) => {
        const entry = bound.get(id);
        if (entry === undefined) return null;
        const status = schema.resolveField(entry, 'status');
        return (
          <button
            key={id}
            type="button"
            data-testid="whiteboard-record-chip"
            onClick={() => open(entry.path)}
            // Anchored to the node's lower edge, slightly overlapping it —
            // the card reads as attached to the node without covering its
            // label. Plane-local units; the parent transform does the rest.
            style={{ left: rect.x + 4, top: rect.y + rect.h - 10, maxWidth: rect.w + 80 }}
            className="pointer-events-auto absolute flex items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 shadow-[var(--shadow-sm)] hover:border-cortex-500"
          >
            <span className="truncate text-xs font-medium text-n-800">{entry.title}</span>
            {/* Capability-gated, never type-routed: resolveField returns an
                empty display when the entry has no status, and FieldChip
                renders null for an empty display. */}
            <FieldChip resolved={status} />
          </button>
        );
      })}
    </div>
  );
}
```

`useCanvasTransform` is Stage D's context reader (spec D2). Verify its export name and value shape (`{ x, y, scale }` vs `{ offset, scale }`) in `src/mermaid/CanvasViewport.tsx` before writing, and adjust the mock in Step 4 to match reality.

Run: `pnpm test:run src/views/RecordChipOverlay.test.tsx` — Expected: 3 passed.

- [ ] **Step 6: Wire the overlay and the Add-record bar into WhiteboardView**

In `WhiteboardCanvas` (WhiteboardView.tsx), pass the overlay and grow the host bar:

```tsx
  const [adding, setAdding] = useState(false);
  const bound = useMemo(
    () => (code === null ? new Map<string, Entry>() : recordBindings(code, entries)),
    [code, entries],
  );
  const boundPaths = useMemo(() => new Set([...bound.values()].map((e) => e.path)), [bound]);

  const addRecord = (entry: Entry) => {
    setAdding(false);
    if (code === null) return;
    const next = insertRecordNode(code, entry);
    // Opaque source (hand-edited into a non-flowchart) cannot take a node;
    // the store-layer ethos — say so, do not throw.
    if (next === null) {
      toast('This canvas is not a flowchart, so records can’t be placed on it');
      return;
    }
    handleChange(next);
  };
```

```tsx
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The whiteboard's own bar — NOT part of FullScreenDiagramEditor.
          Add-record is a host concern (spec D8: the action lists the VIEW's
          entries), and the shared editor must not learn about records. */}
      <div className="relative flex h-9 flex-none items-center gap-1.5 border-b border-n-200 px-3">
        <button
          type="button"
          data-testid="whiteboard-add-record"
          onClick={() => setAdding((v) => !v)}
          className="rounded-md border border-n-200 bg-transparent px-2 py-0.5 text-xs text-n-700 hover:bg-n-50"
        >
          Add record
        </button>
        {SAVE_LABEL[saveState] !== null && (
          <span className="ml-auto text-xs text-[var(--text-meta)]" data-testid="whiteboard-save-state">
            {SAVE_LABEL[saveState]}
          </span>
        )}
        {adding && (
          <AddRecordPopover
            entries={entries.filter((e) => !boundPaths.has(e.path))}
            onPick={addRecord}
            onClose={() => setAdding(false)}
          />
        )}
      </div>
      <FullScreenDiagramEditor
        code={code}
        onChangeCode={handleChange}
        title={viewName}
        embedded
        overlay={<RecordChipOverlay code={code} entries={entries} schema={schema} />}
      />
    </div>
  );
```

(Lift the `SAVE_LABEL` record from DiagramPage.tsx:21-27 — import it if DiagramPage exports it, else duplicate the five-line record with a pointer comment; do not export a new symbol from a page module just for this.)

`AddRecordPopover`, in the same file — the picker is `quickOpenScore` (the app's one fuzzy matcher, `src/lib/quickOpenScore.ts:20`) over an `Input`, in a `MenuSurface`-styled anchored panel, the same anatomy `LayoutPicker` uses (ViewTabs.tsx:377-429 — scrim button + surface; this bar is not a scroll container, so plain `absolute` works where the tab strip needed `FixedBelowAnchor`):

```tsx
function AddRecordPopover({
  entries,
  onPick,
  onClose,
}: {
  entries: Entry[];
  onPick: (entry: Entry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const results = useMemo(() => {
    if (q === '') return entries.slice(0, 25);
    return entries
      .map((e) => ({ e, score: quickOpenScore(q, e.title) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)
      .map((r) => r.e);
  }, [entries, q]);

  return (
    <>
      <button
        type="button"
        aria-label="Close record picker"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
      />
      <div
        data-testid="whiteboard-record-picker"
        className="absolute left-3 top-9 z-50 w-[280px] rounded-lg border border-n-200 bg-n-0 p-2 shadow-[var(--shadow-lg)]"
      >
        <Input
          autoFocus
          size="sm"
          ariaLabel="Find a record"
          placeholder="Find a record…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          width="100%"
        />
        <div className="mt-1.5 max-h-64 overflow-y-auto">
          {results.map((e) => (
            <button
              key={e.path}
              type="button"
              data-testid="whiteboard-add-option"
              onClick={() => onPick(e)}
              className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm text-n-700 hover:bg-n-50"
            >
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <span className="flex-none text-2xs text-n-400">{e.folder}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-n-400">
              {entries.length === 0 ? 'Every record is already on the canvas' : 'No matches'}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
```

(Imports this step adds to WhiteboardView.tsx: `useMemo`, `useState`, `Input`, `quickOpenScore`, `RecordChipOverlay`, `insertRecordNode`, `recordBindings`.)

- [ ] **Step 7: Extend `WhiteboardView.test.tsx`**

Add to the existing suite (fake editor mock now needs to surface the overlay and the change channel):

```tsx
vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({
  FullScreenDiagramEditor: ({
    code,
    overlay,
  }: {
    code: string;
    overlay?: React.ReactNode;
  }) => (
    <div data-testid="fake-editor">
      {code}
      {overlay}
    </div>
  ),
}));
vi.mock('@/views/RecordChipOverlay', () => ({
  RecordChipOverlay: () => <div data-testid="fake-overlay" />,
}));
```

```tsx
  it('Add record inserts a titled node and its click binding as one edit', async () => {
    fs().set('delivery/whiteboards/map.mmd', 'flowchart TD\n');
    render(
      <WhiteboardView
        entries={[shipV2] /* scanner-shaped fixture as in whiteboardBindings.test */}
        presentation={{ ...base, whiteboard: { file: 'delivery/whiteboards/map.mmd' } }}
        schema={schema as never}
        host={{ folder: 'delivery', viewName: 'Map' }}
      />,
    );
    await screen.findByTestId('fake-editor');
    await userEvent.click(screen.getByTestId('whiteboard-add-record'));
    await userEvent.click(screen.getByTestId('whiteboard-add-option'));
    // The edit went through the autosave channel; after the debounce the
    // file on the mock disk carries both the node and the binding.
    await waitFor(() => {
      const file = fs().get('delivery/whiteboards/map.mmd') ?? '';
      expect(file).toContain('Ship v2');
      expect(file).toContain('delivery/ship-v2.md');
    });
  });

  it('a record already on the canvas is not offered again', async () => {
    fs().set(
      'delivery/whiteboards/map.mmd',
      'flowchart TD\n  a[Ship v2]\n  click a "delivery/ship-v2.md"\n',
    );
    render(/* same mount, entries: [shipV2] */);
    await screen.findByTestId('fake-editor');
    await userEvent.click(screen.getByTestId('whiteboard-add-record'));
    expect(screen.queryByTestId('whiteboard-add-option')).toBeNull();
    expect(screen.getByText('Every record is already on the canvas')).toBeTruthy();
  });
```

The debounce assertion: `useDiagramFile` flushes 500ms after the edit — under `waitFor`'s 10s ceiling that lands naturally; if the suite prefers fake timers, follow whatever `DiagramPage.test.tsx:66` ("debounce-saves edits raw") already does and copy its timing idiom exactly.

- [ ] **Step 8: Full check + commit**

Run: `pnpm test:run src/views/ && pnpm test:run src/mermaid/ && pnpm typecheck && pnpm lint`
Expected: clean, including Stage D's editor tests with the new `overlay` case.

```bash
git add src/views/whiteboardBindings.ts src/views/whiteboardBindings.test.ts src/views/RecordChipOverlay.tsx src/views/RecordChipOverlay.test.tsx src/views/WhiteboardView.tsx src/views/WhiteboardView.test.tsx src/mermaid/FullScreenDiagramEditor.tsx src/mermaid/FullScreenDiagramEditor.test.tsx
git commit -m "feat(views): whiteboard nodes carry record cards — bound, badged, clickable (M29.47)"
```

---

### Task H4: Wiring the hosts (M29.48)

`entries`, `schema`, and `onPresentationChange` already flow through all three `ViewCanvas` call sites; the whiteboard arm additionally needs `whiteboardHost` — and only the two PAGE hosts supply it. The audit of the three call sites:

| Call site | Passes host? | Why |
|---|---|---|
| `ListPage.tsx:415` | **yes** — folder of the List's own file | The canvas lives beside the list that owns it: the collection folder, or vault root for a root-level List (spec D8). |
| `TypePage.tsx:364` | **yes** — folder of the Type doc | A Type screen's saved views are real views (M12.3); its whiteboards land beside the schema doc that owns them. `TypeListing.docPath` (typeCatalog.ts:110) can be null for a doc-less type — that host passes `folder: ''` (vault root). |
| `DashboardView.tsx:189` | **no** — excluded | Stated, not forgotten: a dashboard block embedding a whiteboard tab renders the "lives on their list" face. A whiteboard is an editor, not a 300px tile; and while `hasBlocks` only guards dashboard-in-dashboard recursion, an embedded EDITOR inside a read-only block grid raises the same class of question (whose autosave? whose keyboard?) that the recursion guard exists to close. The face says where to go instead. |

**Files:**
- Modify: `src/pages/ListPage.tsx`
- Modify: `src/pages/TypePage.tsx`
- Modify: `src/app/viewActions.test.ts`

- [ ] **Step 1: Write the failing seed-sanity tests**

Append to `src/app/viewActions.test.ts` (reuse its existing fixtures — it already builds kitchen-sink presentations at viewActions.test.ts:41-100):

```ts
describe('seedView and the whiteboard (M29.48)', () => {
  const board: Presentation = {
    type: 'whiteboard',
    group: [{ field: 'status' }],
    sort: [{ field: 'modifiedAt', dir: 'desc' }],
    columns: [{ field: 'status' }],
    whiteboard: { file: 'delivery/whiteboards/map.mmd' },
  };

  it('a new whiteboard tab gets no file pointer and no layout-specific keys', () => {
    // Seeded from a fully-configured gantt: the query travels (that is what
    // "another view of this data" means), the gantt's layout keys do not,
    // and no pointer appears from nowhere.
    const gantt: Presentation = {
      type: 'gantt',
      group: [{ field: 'status' }],
      sort: [{ field: 'due', dir: 'asc' }],
      columns: [{ field: 'due' }],
      dateField: 'due',
      zoom: 'week',
      dependencyField: 'blocked_by',
    };
    const seeded = seedView('Map', 'whiteboard', [], gantt);
    expect(seeded.presentation.type).toBe('whiteboard');
    expect(seeded.presentation.whiteboard).toBeUndefined();
    expect(seeded.presentation.dateField).toBeUndefined();
    expect(seeded.presentation.zoom).toBeUndefined();
    expect(seeded.presentation.dependencyField).toBeUndefined();
    // SharedKeys travel BY DESIGN (they are the query, not the layout):
    // nothing on a whiteboard reads them, nothing is harmed by them, and a
    // later switch back to a record layout finds the query intact.
    expect(seeded.presentation.group).toEqual(gantt.group);
    expect(seeded.presentation.columns).toEqual(gantt.columns);
  });

  it('a whiteboard seeded from a whiteboard gets its OWN canvas', () => {
    expect(seedView('Map 2', 'whiteboard', ['map'], board).presentation.whiteboard).toBeUndefined();
  });

  it('a table seeded from a whiteboard carries no pointer into its YAML', () => {
    const yaml = yamlFor(seedView('Grid', 'table', [], board));
    expect(yaml).not.toContain('whiteboard');
  });
});
```

Run: `pnpm test:run src/app/viewActions.test.ts` — Expected: the three new tests PASS already (H1's `NEVER_SEEDED` + `KEY_NEEDS` did the work — these tests pin the app-layer seam so a refactor of either half is caught here). If any fails, H1 was mis-implemented; fix there, not here.

- [ ] **Step 2: `ListPage.tsx` — pass the host**

At the `ViewCanvas` call (ListPage.tsx:415), add:

```tsx
          whiteboardHost={{
            // The folder of the List's OWN file — `delivery` for a list in a
            // collection, '' for a root-level `.list.yml` (no collection
            // folder to speak of; the canvas lands in a top-level
            // whiteboards/). `list.path` comes from the scan, so this is the
            // folder the file actually lives in, not a reconstruction.
            folder: list.path.includes('/')
              ? list.path.slice(0, list.path.lastIndexOf('/'))
              : '',
            viewName: activeView.name,
          }}
```

- [ ] **Step 3: `TypePage.tsx` — pass the host**

At the `ViewCanvas` call (TypePage.tsx:364), add the same shape derived from the Type doc:

```tsx
          whiteboardHost={{
            // Beside the Type doc that owns the saved views (M12.3). A
            // doc-less type has no folder of its own; its canvases land in a
            // top-level whiteboards/.
            folder:
              listing.docPath !== null && listing.docPath.includes('/')
                ? listing.docPath.slice(0, listing.docPath.lastIndexOf('/'))
                : '',
            viewName: activeView.name,
          }}
```

(Verify the in-scope variable names — `listing` and `activeView` per TypePage.tsx:100-170 — and whether `TypeListing.docPath` is the actual field name at typeCatalog.ts:54-110.)

- [ ] **Step 4: DashboardView — verify the exclusion, change nothing**

Confirm `DashboardView.tsx:189`'s `ViewCanvas` call gains no prop, and that `WhiteboardView.test.tsx`'s "unavailable face" test (H2 Step 4) covers the resulting render. If Task H5's `ViewCanvas.test.tsx` additions are done later, this behavior is double-covered there via the real switch arm — that is intended.

- [ ] **Step 5: Live-check both hosts, then commit**

Run: `pnpm test:run && pnpm typecheck && pnpm lint`
Then a manual pass against `PORT=5273 pnpm dev`: open the demo vault → Delivery → Delivery schedule → `+` new view → Whiteboard → the tab opens on an empty canvas and `delivery/whiteboards/<name>.mmd` exists (mock fs in browser dev; check the sidebar file tree after the rescan). Repeat once on a Type screen. (Memory: chrome-devtools MCP is usually blocked by the user's own Chrome — check by eye, or drive Playwright directly.)

```bash
git add src/pages/ListPage.tsx src/pages/TypePage.tsx src/app/viewActions.test.ts
git commit -m "feat(views): lists and type screens host whiteboard tabs; dashboards decline (M29.48)"
```

---

### Task H5: The sweep — fossils the tenth kind disturbs (M29.49)

The registry pattern means most surfaces updated themselves; what remains is prose and tests that hardcoded a count. Each item below was verified against the worktree — these are the real fossils, with their real locations.

**Files:**
- Modify: `e2e/collections.spec.ts`
- Modify: `src/views/ViewTabs.tsx`
- Modify: `src/views/ViewToolbar.tsx`
- Modify: `src/views/ViewCanvas.test.tsx`

- [ ] **Step 1: `e2e/collections.spec.ts` — "the six, and only the six"**

The test at collections.spec.ts:179-198 ("views: all six are reachable…") predates gallery/chart/dashboard — the fossil is three kinds stale ALREADY; the tenth is the excuse to fix it properly. Replace the comment and the loop:

```ts
  // Every kind in the catalog is offered — driven by VIEW_KINDS, so this
  // list is the e2e twin of viewKinds.test's registration contract — and
  // the retired kinds are offered nowhere. (This said "the six" for four
  // milestones while the app grew to ten; counts in prose rot, hence the
  // explicit roster.)
  await openLayoutPicker(page);
  for (const kind of [
    'table',
    'list',
    'board',
    'calendar',
    'gantt',
    'timeline',
    'gallery',
    'chart',
    'dashboard',
    'whiteboard',
  ]) {
    await expect(page.getByTestId(`view-switch-${kind}`)).toBeVisible();
  }
  await expect(page.getByTestId('view-switch-tree')).toHaveCount(0);
  await expect(page.getByTestId('view-switch-split')).toHaveCount(0);
  await page.getByLabel('Close layout picker').click();
```

Also rename the test title: `'views: every kind is offered, and the date views place records on an axis'`. Do NOT touch the rest of the test (the gantt/timeline/calendar assertions stand). `e2e/smoke.spec.ts`'s `switchLayout` helper (smoke.spec.ts:47) enumerates nothing — verified: it switches to `list` and `board` by testid — so it needs no change; say so in the commit body rather than editing it to prove it was read.

- [ ] **Step 2: `ViewTabs.tsx` — two stale texts**

1. `LayoutPicker`'s docstring (ViewTabs.tsx:377): `/** Anchored popover listing the six layouts. */` → `/** Anchored popover listing every layout in the catalog (VIEW_KINDS). */`
2. `NewViewForm`'s tile grid (ViewTabs.tsx:559): ten tiles in `grid-cols-3` leaves a lone tenth tile on a fourth row. **Decision: `grid-cols-4`, and the popover widens `w-[268px]` → `w-[300px]`** so four `text-2xs` labels ("Whiteboard", "Dashboard" are the long ones) fit without wrapping — 10 tiles lay out 4/4/2, which reads as a grid rather than a remainder:

```tsx
        <div
          data-testid="new-view-form"
          className="z-50 w-[300px] rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]"
        >
```

```tsx
          {/* 4-up since the catalog passed nine kinds (M29.49): ten tiles in
              three columns left a stranded fourth row. 4/4/2 reads as a grid. */}
          <div className="mt-2 grid grid-cols-4 gap-1">
```

Eyeball it once against the dev server (the `new-view` button in any tab row): no label may wrap or truncate. If "Whiteboard" wraps at 300px, go to `w-[320px]`, not to a shorter label.

- [ ] **Step 3: `ViewToolbar.tsx` — the "six views" comment**

The comment at ViewToolbar.tsx:245-247 annotates the segmented layout control (`showLayout` — currently passed `false` by both page hosts, but the control still renders wherever a future host asks). Replace:

```tsx
      {/* M10: one layout selected at a time, offered from VIEW_SEGMENTS so
          the roster can never drift from the catalog. "Hierarchy" stayed
          retired — any layout nests when its grouping chain descends a
          relation, so a whole kind for it duplicated a control. */}
```

- [ ] **Step 4: `ViewCanvas.test.tsx` — the whiteboard faces through the real switch**

Append to `src/views/ViewCanvas.test.tsx` (match its existing fixture style — it builds presentations and renders `ViewCanvas` directly, ViewCanvas.test.tsx:57-88; reuse its schema/entries fixtures). The heavy editor never mounts in these cases (both faces precede it), but add the render-chain mock anyway so a future face change cannot hang jsdom:

```tsx
vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({
  FullScreenDiagramEditor: () => <div data-testid="fake-editor" />,
}));
```

```tsx
describe('ViewCanvas whiteboard faces (M29.49)', () => {
  const whiteboard: Presentation = {
    type: 'whiteboard',
    group: [],
    sort: [{ field: 'modifiedAt', dir: 'desc' }],
    columns: [],
  };

  it('without a host (a dashboard block) it declines with directions', () => {
    render(
      <ViewCanvas
        entries={[]}
        allEntries={[]}
        presentation={whiteboard}
        schema={schema}
        fields={[]}
        scope="test"
        filtered={false}
      />,
    );
    expect(screen.getByTestId('whiteboard-unavailable')).toBeTruthy();
    expect(screen.getByText(/lives on their list/i)).toBeTruthy();
  });

  it('with a host and no file it enters the create-on-open flow', () => {
    // vaultPath is null in this suite (no openVault), so creation cannot
    // proceed — which is exactly the stub state the task pins: the arm
    // routes to WhiteboardView and shows the preparing face rather than a
    // record layout or a crash. The full create path is WhiteboardView.test's.
    render(
      <ViewCanvas
        entries={[]}
        allEntries={[]}
        presentation={whiteboard}
        schema={schema}
        fields={[]}
        scope="test"
        filtered={false}
        whiteboardHost={{ folder: 'delivery', viewName: 'Map' }}
      />,
    );
    expect(screen.getByTestId('whiteboard-creating')).toBeTruthy();
  });
});
```

(If the suite's shared `beforeEach` DOES open a vault, the second case will create for real against the mock fs — then assert `whiteboard-creating` first and the `writeTextFile` result via `__cerebroMockFs` after, mirroring WhiteboardView.test. Write to what the suite actually does.)

- [ ] **Step 5: viewKinds completeness check**

`src/views/viewKinds.test.ts` was already extended in H1; re-read it now against the final code and confirm the tenth kind appears in: the registration roster test, the distinct-icon/label/testid tests (automatic — they iterate), the capability-readback loop (`isCanvas` line added in H1), the parser round-trip loop (automatic — it iterates `VIEW_TYPES`), and the carry-over `forbidden` table (the `['whiteboard', false]` row). Nothing new should be needed; this step exists so "completeness" is a checked box, not an assumption.

- [ ] **Step 6: Run everything, then commit**

Run: `pnpm test:run && pnpm typecheck && pnpm lint`

```bash
git add e2e/collections.spec.ts src/views/ViewTabs.tsx src/views/ViewToolbar.tsx src/views/ViewCanvas.test.tsx
git commit -m "test(views): sweep the six-kind fossils the tenth kind disturbed (M29.49)"
```

(The collections.spec edit is exercised in H6's e2e run — e2e does not gate this commit locally, but pre-push runs the full gate; if pre-push includes e2e in this repo's hook, run H6 Step 2 before pushing.)

---

### Task H6: End to end + the full gate (M29.50)

**Files:**
- Create: `e2e/whiteboard.spec.ts`

- [ ] **Step 1: Write the spec**

A new file rather than growing collections.spec: the flow mutates the mock disk heavily (a created view, a created file, an edited file), and collections.spec's tests assume the seeded corpus. Boot/expand are copied from collections.spec.ts:9-33 verbatim.

```ts
import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
  }
}

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

async function expand(page: Page, name: string): Promise<void> {
  const caret = page.getByRole('button', { name: `Expand ${name}` });
  if (await caret.isVisible()) await caret.click();
}

test('whiteboard: a tab creates its canvas, takes a record, and opens it', async ({ page }) => {
  await boot(page);
  await expand(page, 'Delivery');
  await page
    .getByTestId('collection-node-list')
    .filter({ hasText: 'Delivery schedule' })
    .getByRole('button', { name: 'Delivery schedule', exact: true })
    .click();

  // Create the tab: + → Whiteboard → Create (same idiom as
  // collections.spec.ts:292-293's board creation).
  await page.getByTestId('new-view').click();
  await page.getByTestId('new-view-whiteboard').click();
  await page.getByTestId('create-view').click();

  // First open creates the canvas beside the list — the collection folder,
  // under whiteboards/, named for the view.
  await expect(page.getByTestId('whiteboard-view')).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...window.__cerebroMockFs.keys()].filter((k) =>
          /^delivery\/whiteboards\/.+\.mmd$/.test(k),
        ),
      ),
    )
    .toHaveLength(1);
  const mmdPath = (
    await page.evaluate(() =>
      [...window.__cerebroMockFs.keys()].filter((k) => /^delivery\/whiteboards\//.test(k)),
    )
  )[0];

  // …and the pointer is persisted on the view in the List's YAML.
  await expect
    .poll(async () =>
      page.evaluate(() => window.__cerebroMockFs.get('delivery/delivery-schedule.list.yml') ?? ''),
    )
    .toContain('whiteboard');
  await expect
    .poll(async () =>
      page.evaluate(() => window.__cerebroMockFs.get('delivery/delivery-schedule.list.yml') ?? ''),
    )
    .toContain(mmdPath);

  // Add a record: the picker offers the view's own entries; pick the first.
  await page.getByTestId('whiteboard-add-record').click();
  const firstOption = page.getByTestId('whiteboard-add-option').first();
  await expect(firstOption).toBeVisible();
  const pickedTitle = (await firstOption.textContent()) ?? '';
  await firstOption.click();

  // One edit: a titled node + its click binding land in the file after the
  // autosave debounce.
  await expect
    .poll(async () =>
      page.evaluate((p) => window.__cerebroMockFs.get(p) ?? '', mmdPath),
    )
    .toContain('click');

  // The bound node wears its record chip (real mermaid render in Chromium —
  // give the lazy chunk the same budget diagrams.spec allows)…
  const chip = page.getByTestId('whiteboard-record-chip').first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  expect(pickedTitle).toContain((await chip.textContent())?.trim().split('\n')[0] ?? '');

  // …and clicking it opens the record in place (M9.3): detail panel, same page.
  await chip.click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  await expect(page.getByTestId('whiteboard-view')).toBeVisible();
});

test('whiteboard: reopening the tab finds the same canvas, not a second file', async ({
  page,
}) => {
  await boot(page);
  await expand(page, 'Delivery');
  await page
    .getByTestId('collection-node-list')
    .filter({ hasText: 'Delivery schedule' })
    .getByRole('button', { name: 'Delivery schedule', exact: true })
    .click();
  await page.getByTestId('new-view').click();
  await page.getByTestId('new-view-whiteboard').click();
  await page.getByTestId('create-view').click();
  await expect(page.getByTestId('whiteboard-view')).toBeVisible({ timeout: 10_000 });

  // Away and back.
  await page.getByTestId('view-tabs').getByRole('tab').first().click();
  await page.getByTestId('view-tabs').getByRole('tab').last().click();
  await expect(page.getByTestId('whiteboard-view')).toBeVisible();

  // Still exactly one canvas file — create-on-open is once, not per visit.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...window.__cerebroMockFs.keys()].filter((k) => /^delivery\/whiteboards\//.test(k)),
      ),
    )
    .toHaveLength(1);
});
```

Selector reality-checks while writing (do these, don't trust the plan): the sidebar list-node locators are collections.spec's own (collections.spec.ts:184-188); the tab strip's roles come from ViewTabs (`role="tab"`, `view-tabs` testid); the chip title assertion is deliberately loose (the picker row includes the folder span — compare prefixes, or grab the row's title span instead if this flakes). If the seeded structural editor's empty `flowchart TD` renders something that occludes the chip layer, that is a bug in the overlay's `pointer-events` layering, not the test.

- [ ] **Step 2: Run the e2e suite**

Run: `PORT=5273 pnpm e2e -- whiteboard.spec.ts`
Expected: 2 passed. Then the full `PORT=5273 pnpm e2e` — collections.spec's updated ten-kind roster runs here too. Nothing in this stage edits `demo-vault/`, so no other spec's counts should move; if one does, something wrote into the corpus and that is a defect, not an assertion to update.

- [ ] **Step 3: The rename question — answered, documented, not faked**

The task asks whether renaming the collection folder keeps the whiteboard working. **Checked: it does not, and cannot yet.** A folder rename remaps navigation state only (`remapSelection`, `src/stores/navStore.ts:34-143`); no code rewrites path references stored INSIDE files — the whiteboard's `whiteboard.file` in the List YAML shares this exposure with dashboard blocks' `collection` refs, which have shipped with it since M16.28. The whiteboard's behavior under a stale pointer is therefore the designed one: the tombstone face names the missing path and offers "Start a new canvas" (H2 Step 6; unit-covered by the tombstone test). Re-pointing at the moved file is a one-line hand edit of the YAML — a files-first app leaves that door open. Do not build rename remapping inside this stage; if it becomes worth doing, it is a vault-wide reference-rewrite concern (dashboard blocks, whiteboards, and anything after them) and deserves its own phase. Record this in the commit body.

- [ ] **Step 4: The Rust question — verified no-touch**

Confirm and state in the commit body:

```bash
git status --short src-tauri   # expected: empty
cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

No Rust change was needed because: `write_text_file`'s extension allowlist already covers `.mmd` (`src-tauri/src/vault/write.rs:266-291`), it writes into nested folders (its own test writes `diagrams/…`, write.rs:891-901), dedupes stems, and refuses `knowledge/` and vault escapes; the TS mock mirrors every guard (`src/lib/mockIpc.ts:513-533`) — parity that existing tests already pin. Reads and saves go through `readNote`/`saveNote`, unchanged since M29.21.

- [ ] **Step 5: The full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage && PORT=5273 pnpm e2e`
Expected: all green; coverage at or above the ratchet (every new file shipped with its tests, so this should clear with margin).

- [ ] **Step 6: Commit**

```bash
git add e2e/whiteboard.spec.ts
git commit -m "test(views): whiteboard end to end — create the canvas, place a record, open it (M29.50)"
```

---

## Stage H exit criteria

- `whiteboard` is the tenth member of `VIEW_TYPES`; every compile-forced registry (`CAPABILITIES`, `KEY_NEEDS`, `LAYOUT_LABEL`, the `ViewCanvas` switch) describes it, and every picker (tab menu, new-view form, settings panel, segmented control) offers it with the `presentation` icon — with zero per-picker edits, because the registry pattern is the feature.
- A whiteboard tab on a List (or Type screen) creates `<host folder>/whiteboards/<view-slug>.mmd` exactly once on first open, persists the pointer through the view's own YAML, and edits the file through `FullScreenDiagramEditor` with DiagramPage's exact autosave discipline — now single-sourced in `useDiagramFile`, with `DiagramPage.test.tsx` passing **unchanged** as the refactor's proof, keyed mounts preserved at both hosts.
- `Presentation.whiteboard` survives serialize→parse round trips (allowlist + deep clone both covered by tests); a null pointer is never written; `carryOver` never seeds the pointer into any new tab.
- Bound nodes (understood `click` lines resolving to vault entries) wear record chips — title plus status `FieldChip`, capability-gated, never type-routed — inside the canvas plane, tracking pan/zoom and re-measuring on render; clicking opens the record in-place. "Add record" offers the view's not-yet-placed entries and inserts node + binding as one undo step.
- Dashboards decline whiteboards with a face that says where to go; the stale "six views" prose and the e2e "six and only the six" roster are gone; the new-view grid holds ten tiles without a stranded row.
- The folder-rename limitation is documented where it lives (tombstone comment + commit body), not papered over.
- Full gate green: `pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage && PORT=5273 pnpm e2e`, and `cargo test / fmt / clippy` green with an empty `src-tauri` diff.
