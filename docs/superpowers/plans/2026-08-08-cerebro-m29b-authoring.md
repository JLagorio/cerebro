# M29 Stage B — Mermaid Authoring: Live Side-by-Side, Highlighting, Templates (M29.9–M29.13)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editing a diagram shows a live preview beside the source as you type, errors carry their line and never blank the last good render, the source is syntax-highlighted, and an empty block offers per-type starter templates.

**Architecture:** All inside `src/mermaid/` on top of Stage A: `MermaidBlockView` gains a side-by-side edit mode with a debounced `LivePreview`; `highlight.ts` wraps shiki (lazy, fallback to plain mono); `HighlightedTextarea` overlays highlighted HTML under a transparent textarea; `templates.ts` feeds a card grid shown in the empty state; `detectDiagramType` names the block header.

**Tech Stack:** shiki (new dep, lazy chunk, `mermaid` grammar + github-light/github-dark themes), everything else already present.

**Spec:** `docs/superpowers/specs/2026-08-08-cerebro-m29-mermaid-design.md`
**Prerequisite:** Stage A complete (`2026-08-08-cerebro-m29a-render-core.md`) — `renderMermaid`, `MermaidDiagram`, `MermaidBlockView` exist. Stage A's note on `dangerouslySetInnerHTML` applies to every sink added here: strict-mode mermaid output and shiki-escaped HTML only.

---

## Read this first

- Same traps as Stage A (watch-mode tests, jsdom/no-SVG → mock `./render`, zero-warning lint, corpus discipline). Re-read that section if you start here cold.
- **Behavior change shipped in this stage, on purpose:** commit-on-textarea-blur dies. With a preview pane beside the source, any click into the preview blurs the textarea; blur-commit would slam the editor shut mid-thought. Done (or Cmd+Enter) commits; Escape cancels. Tests below pin exactly this.
- `stopPropagation` on the textarea's `onKeyDown` is load-bearing — without it BlockNote hotkeys fire while typing diagram source. It survives every rewrite here.
- Shiki's `mermaid` grammar: `highlight.ts` treats "grammar unavailable" as a normal outcome (plain mono). If `langs: ['mermaid']` throws at runtime, the catch handles it — the feature degrades, nothing breaks.

---

### Task B1: Side-by-side live edit mode (M29.9)

**Files:**
- Create: `src/mermaid/useDebounced.ts`
- Modify: `src/mermaid/MermaidBlockView.tsx` (edit mode rewritten)
- Modify: `src/mermaid/MermaidBlockView.test.tsx` (extended)

- [ ] **Step 1: Write the failing tests**

Replace the "commits the draft on Done" test and add live-preview coverage in `MermaidBlockView.test.tsx`:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MermaidBlockView } from './MermaidBlockView';

vi.mock('./render', () => ({ renderMermaid: vi.fn() }));
import { renderMermaid } from './render';
const renderMock = vi.mocked(renderMermaid);

describe('MermaidBlockView editing (M29.9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="live"></svg>' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const user = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

  it('live-renders the draft after the debounce window', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    // Empty block shows the template grid after B3; until then, enter edit
    // via the Edit button — keep whichever entry point exists at this task.
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(renderMock).toHaveBeenCalledWith('graph TD'));
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-live-preview').innerHTML).toContain('data-fake="live"'),
    );
  });

  it('keeps the last good render and shows a lined error while the draft is broken', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(screen.getByTestId('mermaid-live-preview')).toBeInTheDocument());

    renderMock.mockResolvedValue({ ok: false, message: 'Parse error on line 2: bad', line: 2 });
    await user().type(screen.getByLabelText('Mermaid source'), '\n  A -->');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(screen.getByTestId('mermaid-edit-error')).toBeInTheDocument());
    expect(screen.getByTestId('mermaid-edit-error').textContent).toContain('Line 2');
    // Stale-but-good svg is still on screen, dimmed — never a blank pane.
    expect(screen.getByTestId('mermaid-live-preview').innerHTML).toContain('data-fake="live"');
  });

  it('Done commits, Escape cancels', async () => {
    const onChangeCode = vi.fn();
    render(<MermaidBlockView code="" onChangeCode={onChangeCode} />);
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD');
    await user().click(screen.getByRole('button', { name: 'Done' }));
    expect(onChangeCode).toHaveBeenCalledWith('graph TD');

    await user().click(screen.getByRole('button', { name: 'Edit' }));
    await user().type(screen.getByLabelText('Mermaid source'), ' MORE');
    await user().keyboard('{Escape}');
    // Cancel: no second commit, editor closed.
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Mermaid source')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm test:run src/mermaid/MermaidBlockView.test.tsx`
Expected: new tests FAIL (no `mermaid-live-preview` testid, blur-commit still active).

- [ ] **Step 3: Implement `src/mermaid/useDebounced.ts`**

```ts
import { useEffect, useState } from 'react';

/** The value, `ms` behind the caller's — one render per pause, not per keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
```

- [ ] **Step 4: Rewrite the edit mode in `MermaidBlockView.tsx`**

Replace the whole component with:

```tsx
import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MermaidDiagram } from './MermaidDiagram';
import { MermaidLightbox } from './MermaidLightbox';
import { renderMermaid } from './render';
import { useDebounced } from './useDebounced';

/**
 * The mermaid block's body. View mode renders through the shared core; edit
 * mode (M29.9) is side-by-side source + live preview, debounced 250ms. The
 * preview keeps the last GOOD render visible while the draft is broken — a
 * diagram that blanks out mid-edit punishes typing.
 *
 * Commit is explicit (Done / Cmd+Enter); Escape cancels. Blur does NOT commit:
 * with a preview pane beside the source, any click into the preview would
 * blur-commit and slam the editor shut.
 */
export function MermaidBlockView({
  code,
  onChangeCode,
}: {
  code: string;
  onChangeCode: (code: string) => void;
}) {
  const [editing, setEditing] = useState(code.trim() === '');
  const [draft, setDraft] = useState(code);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  const debouncedDraft = useDebounced(draft, 250);

  const commit = () => {
    setEditing(false);
    if (draft !== code) onChangeCode(draft);
  };
  const cancel = () => {
    setDraft(code);
    setEditing(false);
  };

  return (
    <div
      data-testid="mermaid-block"
      contentEditable={false}
      className="my-1 w-full rounded-lg border border-n-200 bg-n-0"
    >
      <div className="flex items-center gap-1.5 border-b border-n-100 px-2.5 py-1">
        <Icon name="waypoints" size={13} color="var(--n-500)" />
        <span className="text-xs font-medium uppercase tracking-[0.05em] text-n-500">Mermaid</span>
        <span className="flex-1" />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (editing) commit();
            else {
              setDraft(code);
              setEditing(true);
            }
          }}
          className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {editing && (
        <div className="flex flex-wrap">
          <textarea
            autoFocus
            aria-label="Mermaid source"
            value={draft}
            placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // stopPropagation is load-bearing: BlockNote hotkeys must not
              // fire while typing diagram source.
              e.stopPropagation();
              if (e.key === 'Escape') cancel();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
            }}
            rows={Math.max(6, draft.split('\n').length + 1)}
            className="min-w-[260px] flex-1 basis-[280px] resize-y border-0 bg-n-25 px-3 py-2 [font-family:var(--font-mono)] text-sm leading-[1.5] text-n-800 outline-none"
          />
          <LivePreview code={debouncedDraft} />
        </div>
      )}

      {!editing && code.trim() !== '' && (
        <div className="px-3 py-2">
          <MermaidDiagram code={code} onExpand={(svg) => setLightboxSvg(svg)} />
        </div>
      )}

      {!editing && code.trim() === '' && (
        <button
          type="button"
          onClick={() => {
            setDraft(code);
            setEditing(true);
          }}
          className="w-full border-0 bg-transparent px-3 py-3 text-left text-sm text-n-400"
        >
          Empty diagram — click to add mermaid source
        </button>
      )}

      {lightboxSvg !== null && (
        <MermaidLightbox
          open
          svg={lightboxSvg}
          title="Diagram"
          onClose={() => setLightboxSvg(null)}
        />
      )}
    </div>
  );
}

/**
 * The edit-mode pane: renders the (debounced) draft, keeps the last good svg
 * when the draft breaks, and names the error's line.
 */
function LivePreview({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; line: number | null } | null>(null);

  useEffect(() => {
    if (code.trim() === '') {
      setSvg(null);
      setError(null);
      return;
    }
    let stale = false;
    void renderMermaid(code).then((r) => {
      if (stale) return;
      if (r.ok) {
        setSvg(r.svg);
        setError(null);
      } else {
        setError({ message: r.message, line: r.line });
        // svg intentionally untouched: the last good render stays visible.
      }
    });
    return () => {
      stale = true;
    };
  }, [code]);

  return (
    <div className="min-w-[260px] flex-1 basis-[280px] border-l border-n-100 px-3 py-2">
      {error !== null && (
        <div
          data-testid="mermaid-edit-error"
          className="mb-1.5 rounded-md bg-danger-50 px-2 py-1 text-xs text-danger-700"
        >
          {error.line !== null ? `Line ${error.line}: ` : ''}
          {error.message.split('\n')[0]}
        </div>
      )}
      {svg !== null && (
        <div
          data-testid="mermaid-live-preview"
          className={`overflow-auto [&_svg]:h-auto [&_svg]:max-w-full ${error !== null ? 'opacity-60' : ''}`}
          // Safe: strict-mode mermaid output, same as every other sink.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {svg === null && error === null && (
        <div className="py-4 text-center text-xs text-n-400">Preview appears as you type</div>
      )}
    </div>
  );
}
```

(`debouncedDraft` is computed at the top of the component, not inline in JSX — hooks cannot live inside conditional JSX; `pnpm lint` enforces this.)

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run src/mermaid/MermaidBlockView.test.tsx`
Expected: all pass, including the Stage A ones still valid (empty-starts-editing, full error surfaced in view mode, lightbox). Delete the old blur-commit expectation if one exists.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/mermaid/useDebounced.ts src/mermaid/MermaidBlockView.tsx src/mermaid/MermaidBlockView.test.tsx
git commit -m "feat(mermaid): editing is side-by-side with a live preview that never blanks (M29.9)"
```

---

### Task B2: Syntax highlighting via shiki (M29.10)

**Files:**
- Modify: `package.json` (add shiki)
- Create: `src/mermaid/highlight.ts`
- Create: `src/mermaid/highlight.test.ts`
- Create: `src/mermaid/HighlightedTextarea.tsx`
- Create: `src/mermaid/HighlightedTextarea.test.tsx`
- Modify: `src/mermaid/MermaidBlockView.tsx` (swap textarea for the new component)

- [ ] **Step 1: Add the dependency**

```bash
pnpm add shiki
```

- [ ] **Step 2: Write the failing highlight test**

Create `src/mermaid/highlight.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

describe('loadMermaidHighlighter', () => {
  it('returns null when shiki (or its mermaid grammar) is unavailable', async () => {
    vi.resetModules();
    vi.doMock('shiki', () => {
      throw new Error('not installed');
    });
    const { loadMermaidHighlighter } = await import('./highlight');
    expect(await loadMermaidHighlighter()).toBeNull();
    vi.doUnmock('shiki');
  });

  it('returns a highlighter that emits html when shiki loads', async () => {
    vi.resetModules();
    vi.doMock('shiki', () => ({
      createHighlighter: vi.fn().mockResolvedValue({
        codeToHtml: (code: string) => `<pre class="shiki">${code}</pre>`,
      }),
    }));
    const { loadMermaidHighlighter } = await import('./highlight');
    const highlight = await loadMermaidHighlighter();
    expect(highlight).not.toBeNull();
    expect(highlight?.('graph TD')).toContain('shiki');
    vi.doUnmock('shiki');
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm test:run src/mermaid/highlight.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/mermaid/highlight.ts`**

```ts
/**
 * Mermaid source highlighting (M29.10) — best effort, never required.
 * Shiki is lazy (its wasm + grammar are a real chunk), memoized, and every
 * failure path resolves to null: the editor then shows plain mono, which is
 * exactly what it showed before this file existed.
 */
export type Highlighter = (code: string) => string;

let promise: Promise<Highlighter | null> | null = null;

export function loadMermaidHighlighter(): Promise<Highlighter | null> {
  promise ??= (async () => {
    try {
      const { createHighlighter } = await import('shiki');
      const h = await createHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: ['mermaid'],
      });
      return (code: string) => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        return h.codeToHtml(code, {
          lang: 'mermaid',
          theme: dark ? 'github-dark' : 'github-light',
        });
      };
    } catch {
      return null;
    }
  })();
  return promise;
}
```

- [ ] **Step 5: Write the failing component test**

Create `src/mermaid/HighlightedTextarea.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HighlightedTextarea } from './HighlightedTextarea';

vi.mock('./highlight', () => ({
  loadMermaidHighlighter: vi.fn(),
}));
import { loadMermaidHighlighter } from './highlight';
const loadMock = vi.mocked(loadMermaidHighlighter);

describe('HighlightedTextarea', () => {
  it('is a working textarea even when no highlighter exists', async () => {
    loadMock.mockResolvedValue(null);
    const onChange = vi.fn();
    render(
      <HighlightedTextarea value="" onChange={onChange} ariaLabel="Mermaid source" rows={4} />,
    );
    await userEvent.type(screen.getByLabelText('Mermaid source'), 'g');
    expect(onChange).toHaveBeenCalledWith('g');
  });

  it('renders the highlight layer when the highlighter loads', async () => {
    loadMock.mockResolvedValue((code) => `<pre class="shiki">${code}</pre>`);
    render(
      <HighlightedTextarea
        value="graph TD"
        onChange={() => {}}
        ariaLabel="Mermaid source"
        rows={4}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-highlight-layer').innerHTML).toContain('shiki'),
    );
  });
});
```

- [ ] **Step 6: Implement `src/mermaid/HighlightedTextarea.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { loadMermaidHighlighter, type Highlighter } from './highlight';

/**
 * A textarea with a highlight layer painted underneath (M29.10). The classic
 * trick: the textarea's text is transparent (caret stays visible), an
 * aria-hidden <div> renders shiki's html in the same font box, and scroll
 * positions are mirrored. If no highlighter loads, the textarea simply keeps
 * visible text — zero behavior difference.
 */
export function HighlightedTextarea({
  value,
  onChange,
  onKeyDown,
  ariaLabel,
  placeholder,
  rows,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  ariaLabel: string;
  placeholder?: string;
  rows: number;
  autoFocus?: boolean;
}) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stale = false;
    void loadMermaidHighlighter().then((h) => {
      if (!stale) setHighlighter(() => h);
    });
    return () => {
      stale = true;
    };
  }, []);

  const sharedFont =
    '[font-family:var(--font-mono)] text-sm leading-[1.5] whitespace-pre-wrap break-words';

  return (
    <div className="relative min-w-[260px] flex-1 basis-[280px] bg-n-25">
      {highlighter !== null && (
        <div
          ref={layerRef}
          data-testid="mermaid-highlight-layer"
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-hidden px-3 py-2 ${sharedFont} [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_code]:!bg-transparent`}
          // Safe: shiki html generated from the user's own source text.
          dangerouslySetInnerHTML={{ __html: highlighter(value) }}
        />
      )}
      <textarea
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (layerRef.current !== null) {
            layerRef.current.scrollTop = e.currentTarget.scrollTop;
            layerRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        rows={rows}
        className={`relative w-full resize-y border-0 bg-transparent px-3 py-2 outline-none ${sharedFont} ${
          highlighter !== null ? 'text-transparent [caret-color:var(--n-800)]' : 'text-n-800'
        }`}
      />
    </div>
  );
}
```

- [ ] **Step 7: Swap it into `MermaidBlockView`**

Replace the edit-mode `<textarea …>` with:

```tsx
<HighlightedTextarea
  autoFocus
  ariaLabel="Mermaid source"
  value={draft}
  placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
  onChange={setDraft}
  onKeyDown={(e) => {
    e.stopPropagation();
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
  }}
  rows={Math.max(6, draft.split('\n').length + 1)}
/>
```

Add `import { HighlightedTextarea } from './HighlightedTextarea';`.

- [ ] **Step 8: Run all mermaid tests**

Run: `pnpm test:run src/mermaid/`
Expected: all pass (B1 tests still green — the textarea contract is unchanged).

- [ ] **Step 9: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add package.json pnpm-lock.yaml src/mermaid/highlight.ts src/mermaid/highlight.test.ts src/mermaid/HighlightedTextarea.tsx src/mermaid/HighlightedTextarea.test.tsx src/mermaid/MermaidBlockView.tsx
git commit -m "feat(mermaid): source pane is syntax-highlighted, degrading to plain mono (M29.10)"
```

---

### Task B3: Template picker in the empty state (M29.11)

**Files:**
- Create: `src/mermaid/templates.ts`
- Create: `src/mermaid/templates.test.ts`
- Modify: `src/mermaid/MermaidBlockView.tsx` (empty state → picker grid)
- Modify: `src/mermaid/MermaidBlockView.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/mermaid/templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TEMPLATES } from './templates';

describe('TEMPLATES', () => {
  it('every template has an id, label, icon, and non-empty starter code', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(10);
    for (const t of TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.icon).toBeTruthy();
      expect(t.code.trim().length).toBeGreaterThan(0);
    }
  });

  it('ids are unique', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });
});
```

Add to `MermaidBlockView.test.tsx`:

```tsx
it('an empty block offers the template grid; picking one enters editing with its code', async () => {
  renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
  render(<MermaidBlockView code="" onChangeCode={() => {}} />);
  expect(screen.getByTestId('mermaid-template-grid')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Flowchart' }));
  const source = await screen.findByLabelText('Mermaid source');
  expect((source as HTMLTextAreaElement).value).toContain('flowchart TD');
});
```

**Design note this test encodes:** the empty state and the "freshly inserted block" state are the same state — both show the template grid (with a "Blank" card) instead of jumping straight into an empty textarea. `editing` starts `false` always; the grid IS the empty experience. B1's tests that began by typing into an auto-opened textarea must now click `Blank` first (update them in this task).

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/`
Expected: templates test FAILS (module missing); block test FAILS (no grid).

- [ ] **Step 3: Implement `src/mermaid/templates.ts`**

```ts
/**
 * Starter sources for the empty-block template grid (M29.11). One entry per
 * commonly-reached diagram type; each renders clean under mermaid 11 defaults.
 * The grid beats ten slash-menu entries: /mermaid stays one item, and the
 * choice appears exactly when it is needed — inside an empty block.
 */
export interface DiagramTemplate {
  id: string;
  label: string;
  /** lucide icon name (Icon resolves it; unresolvable names render visibly, M15.7). */
  icon: string;
  code: string;
}

export const TEMPLATES: DiagramTemplate[] = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    icon: 'waypoints',
    code: 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[Do it]\n  B -->|no| D[Skip it]',
  },
  {
    id: 'sequence',
    label: 'Sequence',
    icon: 'arrow-right-left',
    code: 'sequenceDiagram\n  participant A as Client\n  participant B as Server\n  A->>B: request\n  B-->>A: response',
  },
  {
    id: 'gantt',
    label: 'Gantt',
    icon: 'calendar-range',
    code: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Phase 1\n    Task A :a1, 2026-01-01, 7d\n    Task B :after a1, 5d',
  },
  {
    id: 'state',
    label: 'State',
    icon: 'circle-dot',
    code: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review\n  Review --> Done\n  Done --> [*]',
  },
  {
    id: 'er',
    label: 'Entity-Relation',
    icon: 'database',
    code: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains',
  },
  {
    id: 'class',
    label: 'Class',
    icon: 'boxes',
    code: 'classDiagram\n  class Animal {\n    +name: string\n    +speak() void\n  }\n  Animal <|-- Dog',
  },
  {
    id: 'mindmap',
    label: 'Mindmap',
    icon: 'brain',
    code: 'mindmap\n  root((Idea))\n    Branch A\n      Leaf 1\n    Branch B',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: 'clock',
    code: 'timeline\n  title History\n  2024 : Founded\n  2025 : First release\n  2026 : Growth',
  },
  {
    id: 'pie',
    label: 'Pie',
    icon: 'chart-pie',
    code: 'pie title Share\n  "A" : 45\n  "B" : 35\n  "C" : 20',
  },
  {
    id: 'architecture',
    label: 'Architecture',
    icon: 'server',
    code: 'architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service web(server)[Web] in api\n  web:R -- L:db',
  },
];
```

- [ ] **Step 4: Replace the empty state in `MermaidBlockView.tsx`**

Change the initial state so a freshly inserted block shows the grid rather than a bare textarea:

```tsx
const [editing, setEditing] = useState(false);
```

Replace the `!editing && code.trim() === ''` button with:

```tsx
{!editing && code.trim() === '' && (
  <div data-testid="mermaid-template-grid" className="grid grid-cols-2 gap-1.5 p-3 sm:grid-cols-3">
    {TEMPLATES.map((t) => (
      <button
        key={t.id}
        type="button"
        onClick={() => {
          setDraft(t.code);
          setEditing(true);
        }}
        className="flex items-center gap-2 rounded-md border border-n-200 bg-n-0 px-2.5 py-2 text-left text-sm text-n-700 hover:border-n-300 hover:bg-n-25"
      >
        <Icon name={t.icon} size={14} color="var(--n-500)" />
        {t.label}
      </button>
    ))}
    <button
      type="button"
      onClick={() => {
        setDraft('');
        setEditing(true);
      }}
      className="flex items-center gap-2 rounded-md border border-dashed border-n-200 bg-transparent px-2.5 py-2 text-left text-sm text-n-500 hover:border-n-300"
    >
      <Icon name="pencil" size={14} color="var(--n-400)" />
      Blank
    </button>
  </div>
)}
```

Add `import { TEMPLATES } from './templates';`.

- [ ] **Step 5: Run, fix, commit**

Run: `pnpm test:run src/mermaid/ && pnpm lint && pnpm typecheck`
Expected: green after updating B1's entry-point expectations (click `Blank` to reach the textarea).

```bash
git add src/mermaid/templates.ts src/mermaid/templates.test.ts src/mermaid/MermaidBlockView.tsx src/mermaid/MermaidBlockView.test.tsx
git commit -m "feat(mermaid): an empty block offers real starting points, not a blank box (M29.11)"
```

---

### Task B4: The block names its diagram type (M29.12)

**Files:**
- Create: `src/mermaid/detect.ts`
- Create: `src/mermaid/detect.test.ts`
- Modify: `src/mermaid/MermaidBlockView.tsx` (header label)

- [ ] **Step 1: Write the failing test**

Create `src/mermaid/detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectDiagramType } from './detect';

describe('detectDiagramType', () => {
  it.each([
    ['flowchart TD\n A-->B', 'Flowchart'],
    ['graph LR\n A-->B', 'Flowchart'],
    ['sequenceDiagram\n A->>B: hi', 'Sequence'],
    ['classDiagram\n class A', 'Class'],
    ['stateDiagram-v2\n [*] --> A', 'State'],
    ['erDiagram\n A ||--o{ B : x', 'ER'],
    ['gantt\n title X', 'Gantt'],
    ['pie title X\n "A": 1', 'Pie'],
    ['mindmap\n root((x))', 'Mindmap'],
    ['timeline\n title X', 'Timeline'],
    ['quadrantChart\n title X', 'Quadrant'],
    ['xychart-beta\n title X', 'XY chart'],
    ['architecture-beta\n group a(cloud)[A]', 'Architecture'],
    ['gitGraph\n commit', 'Git graph'],
    ['journey\n title X', 'Journey'],
    ['kanban\n Todo', 'Kanban'],
    ['unknownthing\n x', 'Mermaid'],
    ['', 'Mermaid'],
  ])('detects %s → %s', (code, label) => {
    expect(detectDiagramType(code)).toBe(label);
  });

  it('skips frontmatter and comments', () => {
    expect(detectDiagramType('---\nconfig:\n  layout: elk\n---\n%% note\nflowchart TD\n A')).toBe(
      'Flowchart',
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:run src/mermaid/detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mermaid/detect.ts`**

```ts
/**
 * Names the diagram a fence contains (M29.12) — for the block header, and for
 * Stage C's "is this a flowchart?" gate. First meaningful token wins;
 * frontmatter (`--- … ---` at the top) and `%%` comments are skipped.
 */
const TYPE_LABELS: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, 'Flowchart'],
  [/^sequenceDiagram\b/, 'Sequence'],
  [/^classDiagram/, 'Class'],
  [/^stateDiagram/, 'State'],
  [/^erDiagram\b/, 'ER'],
  [/^gantt\b/, 'Gantt'],
  [/^pie\b/, 'Pie'],
  [/^mindmap\b/, 'Mindmap'],
  [/^timeline\b/, 'Timeline'],
  [/^quadrantChart\b/, 'Quadrant'],
  [/^sankey/, 'Sankey'],
  [/^xychart/, 'XY chart'],
  [/^block-beta\b/, 'Block'],
  [/^packet/, 'Packet'],
  [/^kanban\b/, 'Kanban'],
  [/^architecture/, 'Architecture'],
  [/^radar/, 'Radar'],
  [/^C4/, 'C4'],
  [/^journey\b/, 'Journey'],
  [/^gitGraph\b/, 'Git graph'],
];

export function firstMeaningfulLine(code: string): string {
  const lines = code.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i += 1;
    i += 1;
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('%%')) continue;
    return line;
  }
  return '';
}

export function detectDiagramType(code: string): string {
  const line = firstMeaningfulLine(code);
  for (const [pattern, label] of TYPE_LABELS) {
    if (pattern.test(line)) return label;
  }
  return 'Mermaid';
}
```

- [ ] **Step 4: Use it in the header**

In `MermaidBlockView.tsx`:

```tsx
import { detectDiagramType } from './detect';
```

```tsx
<span className="text-xs font-medium uppercase tracking-[0.05em] text-n-500">
  {detectDiagramType(editing ? draft : code)}
</span>
```

- [ ] **Step 5: Run, commit**

Run: `pnpm test:run src/mermaid/ && pnpm lint && pnpm typecheck`

```bash
git add src/mermaid/detect.ts src/mermaid/detect.test.ts src/mermaid/MermaidBlockView.tsx
git commit -m "feat(mermaid): the block header names the diagram it holds (M29.12)"
```

---

### Task B5: Authoring e2e + stage gate (M29.13)

**Files:**
- Modify: `e2e/diagrams.spec.ts` (add a second test)

- [ ] **Step 1: Add the authoring e2e**

Append to `e2e/diagrams.spec.ts` (same boot; the two structural locators — BlockNote root `.bn-editor` and slash item text `Mermaid diagram` (`MarkdownEditor.tsx:433`) — should be checked against reality before running):

```ts
test('authoring: template, live preview, error banner, commit', async ({ page }) => {
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

  // Open the corpus doc and add a fresh diagram block at the end via slash.
  await page.keyboard.press('Meta+p');
  await page.keyboard.type('Systems map');
  await page.keyboard.press('Enter');
  await page.getByTestId('mermaid-diagram').first().waitFor();

  await page.locator('.bn-editor').click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/mermaid');
  await page.getByText('Mermaid diagram').click();

  // Template grid → Flowchart → live preview appears.
  await page.getByTestId('mermaid-template-grid').waitFor();
  await page.getByRole('button', { name: 'Flowchart' }).click();
  await expect(page.getByTestId('mermaid-live-preview').locator('svg')).toBeVisible({
    timeout: 15_000,
  });

  // Break it → lined error, previous preview retained.
  await page.getByLabel('Mermaid source').fill('flowchart TD\n  A --?>> B');
  await expect(page.getByTestId('mermaid-edit-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-live-preview').locator('svg')).toBeVisible();

  // Fix → banner clears → Done → block shows the committed diagram.
  await page.getByLabel('Mermaid source').fill('flowchart TD\n  A[One] --> B[Two]');
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('mermaid-block').locator('svg').last()).toBeVisible();
});
```

- [ ] **Step 2: Run e2e + full gate**

Run: `PORT=5273 pnpm e2e -- diagrams.spec.ts` — Expected: 2 passed.
Run: `pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage && PORT=5273 pnpm e2e`
Expected: everything green.

- [ ] **Step 3: Commit**

```bash
git add e2e/diagrams.spec.ts
git commit -m "test(mermaid): authoring e2e — template, live preview, lined errors (M29.13)"
```

---

## Stage B exit criteria

- Editing shows source and preview together; typing re-renders ~250ms behind the keystroke; a broken draft dims the last good render and names the line; Done/Cmd+Enter commit, Escape cancels.
- Source is highlighted when shiki + grammar load, silently plain otherwise.
- An empty block presents the template grid (10 types + Blank); the header names the diagram type.
- Full gate green (unit, coverage ratchet, lint, typecheck, e2e; cargo untouched by this stage).
