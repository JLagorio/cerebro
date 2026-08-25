# M43 Shell Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-08-25-m43-shell-completion-design.md` — the Topbar dissolves into the sidebar, My work and Favorites become real, and every sidebar section shares one header anatomy.

**Architecture:** Pure-domain first (engine/myWork), then stores (favorites), then leaf UI (star, SectionHeader), then the two shell surgeries (Sidebar restructure, Topbar deletion) so every commit is green. No Rust changes: the MCP `navigate` tool enumerates only `home | inbox | knowledge | view`, so adding the `mywork` Selection kind is TS-only.

**Tech Stack:** React 19 + Zustand + Tailwind, vitest + Playwright. Gates: `pnpm test:run`, `pnpm lint`, `pnpm typecheck`, `pnpm e2e` (check the port is FREE first), `pnpm format`.

**Commit convention:** `type(scope): sentence (M43.<n>)`.

---

### Task 1: `engine/myWork` — open work, capability-gated (M43.1)

**Files:**
- Create: `src/engine/myWork.ts`
- Create: `src/engine/myWork.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/myWork.test.ts
import { describe, expect, it } from 'vitest';
import { openWork } from './myWork';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';

/** A Type doc whose records are task-like: it declares a status field. */
const taskType = makeEntry({
  type: 'Type',
  title: 'Task',
  path: 'types/task.md',
  properties: {
    fields: { status: { kind: 'status' } },
    statuses: [
      { id: 'todo', label: 'To do', group: 'active' },
      { id: 'doing', label: 'Doing', group: 'active' },
      { id: 'done', label: 'Done', group: 'done' },
    ],
  },
});

/** A Type doc with NO status field: its records are never work. */
const noteType = makeEntry({
  type: 'Type',
  title: 'Note',
  path: 'types/note.md',
  properties: { fields: { topic: { kind: 'text' } } },
});

describe('openWork', () => {
  it('includes only records whose status resolves to an active group', () => {
    const open = makeEntry({
      type: 'Task',
      title: 'Fix login',
      path: 'records/tasks/fix-login.md',
      properties: { status: 'todo' },
    });
    const done = makeEntry({
      type: 'Task',
      title: 'Ship exports',
      path: 'records/tasks/ship-exports.md',
      properties: { status: 'done' },
    });
    const entries = [taskType, open, done];
    const rows = openWork(entries, buildSchema(entries));
    expect(rows.map((r) => r.entry.title)).toEqual(['Fix login']);
    expect(rows[0].status).toMatchObject({ id: 'todo', group: 'active' });
  });

  it('excludes records of a type with no status field — capability, not type name', () => {
    const note = makeEntry({
      type: 'Note',
      title: 'Meeting notes',
      path: 'notes/meeting.md',
      // A status VALUE without a status FIELD does not make a note a task.
      properties: { status: 'todo' },
    });
    const entries = [noteType, note];
    expect(openWork(entries, buildSchema(entries))).toEqual([]);
  });

  it('excludes an unresolvable status rather than guessing — the count counts what the page shows', () => {
    const typo = makeEntry({
      type: 'Task',
      title: 'Mystery',
      path: 'records/tasks/mystery.md',
      properties: { status: 'in-porgress' },
    });
    const unset = makeEntry({
      type: 'Task',
      title: 'No status yet',
      path: 'records/tasks/no-status.md',
      properties: {},
    });
    const entries = [taskType, typo, unset];
    expect(openWork(entries, buildSchema(entries))).toEqual([]);
  });

  it('excludes untyped entries and templates', () => {
    const untyped = makeEntry({ type: null, title: 'Capture', path: 'inbox/capture.md' });
    const template = makeEntry({
      type: 'Task',
      title: 'Task template',
      path: 'templates/task.md',
      folder: 'templates',
      properties: { status: 'todo' },
    });
    const entries = [taskType, untyped, template];
    expect(openWork(entries, buildSchema(entries))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/myWork.test.ts`
Expected: FAIL — `Cannot find module './myWork'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/engine/myWork.ts
import { isTemplate } from '@/lib/templates';
import { hasStatusField } from './columns';
import type { Entry, Schema, StatusDef } from './types';

/**
 * My work (M43) — the vault's open work, capability-gated.
 *
 * An entry belongs iff its TYPE declares a status field (a record with a
 * status field is task-like — never routed by type name) and its current
 * status resolves against the entry's status set to a group of 'active'. A
 * value that does not resolve (a typo, a retired status, no value yet) is
 * unresolvable, not active: the entry is excluded, so the nav count counts
 * exactly what the page shows. No assignee filter — a vault has one author.
 */
export interface OpenWorkRow {
  entry: Entry;
  status: StatusDef;
}

export function openWork(entries: Entry[], schema: Schema): OpenWorkRow[] {
  const rows: OpenWorkRow[] = [];
  for (const e of entries) {
    if (e.type === null || isTemplate(e)) continue;
    const def = schema.types.get(e.type);
    if (def === undefined || !hasStatusField(def.fields)) continue;
    const field = def.fields.find((f) => f.kind === 'status');
    if (field === undefined) continue;
    const raw = e.properties[field.name];
    if (raw === undefined || raw === null || raw === '') continue;
    const id = String(Array.isArray(raw) ? raw[0] : raw);
    const status = schema.statusSetFor(e).find((s) => s.id === id);
    if (status === undefined || status.group !== 'active') continue;
    rows.push({ entry: e, status });
  }
  return rows;
}
```

Note: check `makeEntry`'s defaults in `src/engine/testHelpers.ts` before running —
if `folder: 'templates'` is not how `isTemplate` decides (it may read the path),
match the fixture to whatever `isTemplate` actually inspects.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/engine/myWork.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/myWork.ts src/engine/myWork.test.ts
git commit -m "feat(engine): openWork — the vault's open work, capability-gated (M43.1)"
```

---

### Task 2: `mywork` Selection kind + MyWorkPage (M43.2)

**Files:**
- Modify: `src/engine/types.ts` (Selection union, after the `inbox` arm)
- Create: `src/pages/MyWorkPage.tsx`
- Create: `src/pages/MyWorkPage.test.tsx`
- Modify: `src/App.tsx` (import + dispatch case)

- [ ] **Step 1: Add the kind**

In `src/engine/types.ts`, after `| { kind: 'inbox' }`:

```ts
  // M43 — open work across every database. Capability-gated membership
  // (engine/myWork); no per-entry state rides on the selection.
  | { kind: 'mywork' }
```

- [ ] **Step 2: Write the failing page test**

```tsx
// src/pages/MyWorkPage.test.tsx
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MyWorkPage } from './MyWorkPage';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/engine/testHelpers';

const taskType = makeEntry({
  type: 'Type',
  title: 'Task',
  path: 'types/task.md',
  properties: {
    fields: { status: { kind: 'status' } },
    statuses: [
      { id: 'todo', label: 'To do', group: 'active' },
      { id: 'done', label: 'Done', group: 'done' },
    ],
  },
});

describe('MyWorkPage', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: [] });
  });

  it('groups open work by database and shows the status label', () => {
    useVaultStore.setState({
      entries: [
        taskType,
        makeEntry({
          type: 'Task',
          title: 'Fix login',
          path: 'records/tasks/fix-login.md',
          properties: { status: 'todo' },
        }),
      ],
    });
    render(<MyWorkPage />);
    expect(screen.getByRole('heading', { name: 'My work' })).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fix login/ })).toBeTruthy();
    expect(screen.getByText('To do')).toBeTruthy();
  });

  it('says the empty state in words, never a zero', () => {
    useVaultStore.setState({ entries: [taskType] });
    render(<MyWorkPage />);
    expect(screen.getByText(/Nothing is in progress/)).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });
});
```

Check how sibling page tests (e.g. `src/pages/InboxPage.test.tsx`) seed
`useVaultStore` — if they use a helper or reset more state, mirror it exactly.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/pages/MyWorkPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the page**

```tsx
// src/pages/MyWorkPage.tsx
import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { openWork, type OpenWorkRow } from '@/engine/myWork';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * My work (M43) — every open record across every database, one page.
 *
 * Membership is engine/myWork's capability gate; this page only groups and
 * renders. Grouped by database because "what kind of thing is this" is the
 * axis the vault already navigates by; within a group, status-set order then
 * title, so a board's columns and this list agree about what comes first.
 */
export function MyWorkPage() {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const openPath = useOpenPath();

  const groups = useMemo(() => {
    const rows = openWork(entries, schema);
    const byType = new Map<string, OpenWorkRow[]>();
    for (const row of rows) {
      const key = row.entry.type ?? '';
      const bucket = byType.get(key) ?? [];
      bucket.push(row);
      byType.set(key, bucket);
    }
    return [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, bucket]) => {
        const order = new Map(
          (schema.types.get(type)?.statuses ?? []).map((s, i) => [s.id, i]),
        );
        bucket.sort(
          (a, b) =>
            (order.get(a.status.id) ?? 0) - (order.get(b.status.id) ?? 0) ||
            a.entry.title.localeCompare(b.entry.title),
        );
        return { type, rows: bucket };
      });
  }, [entries, schema]);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="mywork-page">
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        <h2 className="m-0 text-xl font-semibold text-n-900">My work</h2>
        {groups.length === 0 ? (
          <p className="mt-3 text-sm text-n-500">
            Nothing is in progress — no record's status sits in an active group.
          </p>
        ) : (
          groups.map(({ type, rows }) => (
            <section key={type} className="mt-5">
              <div className="flex items-center gap-1.5 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
                <Icon
                  name={typeStyle(type, schema).icon}
                  size={13}
                  color={typeStyle(type, schema).color ?? 'var(--n-400)'}
                />
                {type}
                <span className="[font-family:var(--font-mono)] font-normal normal-case tracking-normal text-n-400">
                  {rows.length}
                </span>
              </div>
              {rows.map(({ entry, status }) => (
                <button
                  key={entry.path}
                  type="button"
                  data-testid="mywork-row"
                  onClick={() => openPath(entry.path)}
                  className="flex h-[34px] w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-2 text-left text-sm text-n-800 hover:bg-n-50"
                >
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.title}
                  </span>
                  <span className="flex flex-none items-center gap-1.5 text-xs text-n-600">
                    {status.color !== null && (
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: status.color }}
                      />
                    )}
                    {status.label}
                  </span>
                </button>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
```

`StatusDef.color` typing: it extends `FieldOption` — check whether `color` is
`string | null` or optional and adjust the guard to match (the compiler will
say).

- [ ] **Step 5: Route it in App.tsx**

Add to the page imports: `import { MyWorkPage } from '@/pages/MyWorkPage';`
In the dispatch (the `selection.kind` switch around line 96), after the
`inbox` case:

```tsx
    case 'mywork':
      return <MyWorkPage />;
```

(Match the exact dispatch style used there — it may be `if` chains; copy the
neighboring form.)

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm vitest run src/pages/MyWorkPage.test.tsx && pnpm typecheck`
Expected: PASS, no type errors (the Selection union addition is additive; if
any exhaustive switch on `Selection['kind']` fails to compile, add the
`mywork` arm it demands).

- [ ] **Step 7: Commit**

```bash
git add src/engine/types.ts src/pages/MyWorkPage.tsx src/pages/MyWorkPage.test.tsx src/App.tsx
git commit -m "feat(shell): My work — open work across every database, one page (M43.2)"
```

---

### Task 3: Favorites store (M43.3)

**Files:**
- Modify: `src/stores/uiStore.ts`
- Modify: `src/stores/uiStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/stores/uiStore.test.ts` (mirror the file's existing describe
style and any localStorage reset in its beforeEach):

```ts
describe('favorites', () => {
  it('toggles a path in and out, preserving pin order', () => {
    const s = useUiStore.getState();
    s.toggleFavorite('a.md');
    s.toggleFavorite('b.md');
    expect(useUiStore.getState().favorites).toEqual(['a.md', 'b.md']);
    useUiStore.getState().toggleFavorite('a.md');
    expect(useUiStore.getState().favorites).toEqual(['b.md']);
  });

  it('prunes favorites that no longer resolve', () => {
    useUiStore.getState().toggleFavorite('gone.md');
    useUiStore.getState().toggleFavorite('here.md');
    useUiStore.getState().pruneFavorites(new Set(['here.md']));
    expect(useUiStore.getState().favorites).toEqual(['here.md']);
  });

  it('persists under cerebro.favorites', () => {
    useUiStore.getState().toggleFavorite('a.md');
    expect(JSON.parse(window.localStorage.getItem('cerebro.favorites') ?? '[]')).toEqual(['a.md']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/stores/uiStore.test.ts`
Expected: FAIL — `toggleFavorite` is not a function.

- [ ] **Step 3: Implement**

In `src/stores/uiStore.ts`:

Interface additions (near `navClosed`):

```ts
  /**
   * Pinned paths (M43) — ordered, vault-relative. Workspace state, not vault
   * content: the same rule that put `cerebro.navClosed` here. A favorite is a
   * POINTER — pruneFavorites drops any that stopped resolving, which the
   * sidebar calls with the paths that still exist.
   */
  favorites: string[];
  toggleFavorite(path: string): void;
  pruneFavorites(existing: Set<string>): void;
```

Key constant beside `NAV_CLOSED_KEY`:

```ts
const FAVORITES_KEY = 'cerebro.favorites';
```

Implementation beside `setNavGroupOpen` (same persistence pattern —
`storeString` + JSON):

```ts
  favorites: loadStringList(FAVORITES_KEY),
  toggleFavorite: (path) => {
    const current = get().favorites;
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path];
    storeString(FAVORITES_KEY, JSON.stringify(next));
    set({ favorites: next });
  },
  pruneFavorites: (existing) => {
    const current = get().favorites;
    const next = current.filter((p) => existing.has(p));
    if (next.length === current.length) return;
    storeString(FAVORITES_KEY, JSON.stringify(next));
    set({ favorites: next });
  },
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/stores/uiStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/uiStore.ts src/stores/uiStore.test.ts
git commit -m "feat(shell): favorites store — pinned paths as workspace state (M43.3)"
```

---

### Task 4: FavoriteStar in three headers (M43.4)

**Files:**
- Create: `src/app/FavoriteStar.tsx`
- Create: `src/app/FavoriteStar.test.tsx`
- Modify: `src/pages/DocPage.tsx` (toolbar, before the overflow menu)
- Modify: `src/detail/DetailHeaderActions.tsx` (beside the widen toggle)
- Modify: `src/pages/AgentsPage.tsx` (agent header controls, before Pause)

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/FavoriteStar.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FavoriteStar } from './FavoriteStar';
import { useUiStore } from '@/stores/uiStore';

describe('FavoriteStar', () => {
  it('reflects and toggles pinned state', async () => {
    useUiStore.setState({ favorites: [] });
    render(<FavoriteStar path="a.md" />);
    const star = screen.getByRole('button', { name: 'Add to favorites' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(star);
    expect(useUiStore.getState().favorites).toEqual(['a.md']);
    expect(
      screen.getByRole('button', { name: 'Remove from favorites' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/app/FavoriteStar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/app/FavoriteStar.tsx
import { Icon } from '@/components/ui/Icon';
import { useUiStore } from '@/stores/uiStore';

/**
 * The pin (M43). One control, three headers — doc page, record panel, agent
 * page — so "this matters, keep it near" is the same gesture everywhere.
 * Warn-500 when pinned: the design's star, and the one warm color the chrome
 * spends on a deliberate user mark.
 */
export function FavoriteStar({ path }: { path: string }) {
  const favorites = useUiStore((s) => s.favorites);
  const toggleFavorite = useUiStore((s) => s.toggleFavorite);
  const on = favorites.includes(path);
  return (
    <button
      type="button"
      data-testid="favorite-star"
      aria-pressed={on}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => toggleFavorite(path)}
      className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-0 bg-transparent hover:bg-n-100"
    >
      <Icon name="star" size={14} color={on ? 'var(--warn-500)' : 'var(--n-400)'} />
    </button>
  );
}
```

- [ ] **Step 4: Mount in the three headers**

- `src/pages/DocPage.tsx`: in the toolbar row (the one holding
  `doc-save-state`), immediately after the save-state span:
  `<FavoriteStar path={entry.path} />`
- `src/detail/DetailHeaderActions.tsx`: in the header action cluster, before
  the overflow menu button: `<FavoriteStar path={entry.path} />`
- `src/pages/AgentsPage.tsx`: in the agent header controls (line ~315),
  before the paused chip: `<FavoriteStar path={entry.path} />`

Add the import in each: `import { FavoriteStar } from '@/app/FavoriteStar';`

- [ ] **Step 5: Run the touched suites**

Run: `pnpm vitest run src/app/FavoriteStar.test.tsx src/pages/DocPage.test.tsx src/detail/DetailHeaderActions.test.tsx src/pages/AgentsPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/FavoriteStar.tsx src/app/FavoriteStar.test.tsx src/pages/DocPage.tsx src/detail/DetailHeaderActions.tsx src/pages/AgentsPage.tsx
git commit -m "feat(shell): the pin — one star in the doc, record, and agent headers (M43.4)"
```

---

### Task 5: SectionHeader — one anatomy for every section (M43.5)

**Files:**
- Create: `src/app/SectionHeader.tsx`
- Create: `src/app/SectionHeader.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/SectionHeader.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SectionHeader } from './SectionHeader';

describe('SectionHeader', () => {
  it('announces expanded state and toggles', async () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="Agents" open onToggle={onToggle} />);
    const head = screen.getByRole('button', { name: 'Agents' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(head);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('renders hover actions that do not toggle the section', async () => {
    const onToggle = vi.fn();
    const onAdd = vi.fn();
    render(
      <SectionHeader
        label="Agents"
        open
        onToggle={onToggle}
        actions={[{ icon: 'plus', label: 'New agent', onClick: onAdd }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New agent' }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/app/SectionHeader.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/app/SectionHeader.tsx
import { Icon } from '@/components/ui/Icon';

export interface SectionAction {
  icon: string;
  label: string;
  onClick: () => void;
  /** e2e reaches for some actions by testid (new-collection). */
  testId?: string;
}

/**
 * One header anatomy for every sidebar section (M43, from the design's
 * `sec()`): rotating chevron + uppercase label toggle the section; actions
 * live on the right, revealed on header hover (and always for keyboard
 * focus), 20px hit targets. Controlled — open state belongs to the caller,
 * because Databases already persists via `typesOpen` and everything else
 * rides the navClosed set.
 */
export function SectionHeader({
  label,
  open,
  onToggle,
  actions = [],
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: SectionAction[];
}) {
  return (
    <div className="group/sec flex items-center gap-0.5 pb-1 pl-1.5 pr-1 pt-3.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 border-0 bg-transparent p-0 text-left text-2xs font-semibold uppercase tracking-[0.06em] text-n-500 hover:text-n-700"
      >
        <span
          className="inline-flex flex-none transition-transform duration-[120ms]"
          style={open ? { transform: 'rotate(90deg)' } : undefined}
        >
          <Icon name="chevron-right" size={13} />
        </span>
        {label}
      </button>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          aria-label={a.label}
          title={a.label}
          data-testid={a.testId}
          onClick={a.onClick}
          className="flex h-5 w-5 flex-none items-center justify-center rounded border-0 bg-transparent text-n-400 opacity-0 hover:bg-n-200 hover:text-n-700 focus-visible:opacity-100 group-hover/sec:opacity-100"
        >
          <Icon name={a.icon} size={13} />
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/SectionHeader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/SectionHeader.tsx src/app/SectionHeader.test.tsx
git commit -m "feat(shell): SectionHeader — the design's one section anatomy (M43.5)"
```

---

### Task 6: Sidebar restructure (M43.6)

The big surgery. Every sub-step below edits `src/app/Sidebar.tsx` unless
named otherwise; run `pnpm vitest run src/app/Sidebar.test.tsx` after each.

**Files:**
- Modify: `src/app/Sidebar.tsx`
- Modify: `src/app/Sidebar.test.tsx`
- Modify: `src/app/CreateMenu.tsx` (trigger + popover styling)
- Modify: `src/components/FileTree.tsx` (`showCreateBar`, `createRef` props)

- [ ] **Step 1: FileTree grows two chrome props**

In `FileTreeProps`:

```ts
  /** Hide the inline New page / New folder bar — the Pages section header
   * owns those affordances in the one-column shell (M43). */
  showCreateBar?: boolean;
  /** Imperative doorway for that header: the tree assigns its root-level
   * creation openers here so the caller need not reimplement the dialogs. */
  createRef?: React.MutableRefObject<{ newPage(): void; newFolder(): void } | null>;
```

In the component (default `showCreateBar = true`), after `openDialog` is
defined:

```ts
  useEffect(() => {
    if (createRef === undefined) return;
    createRef.current = {
      newPage: () => openDialog({ mode: 'new-page', dir: root }),
      newFolder: () => openDialog({ mode: 'new-folder', dir: root }),
    };
    return () => {
      createRef.current = null;
    };
  });
```

Wrap the existing button bar (`<div className="mb-1.5 flex items-center gap-1">`)
in `{showCreateBar && (...)}`.

- [ ] **Step 2: CreateMenu becomes the sidebar's New button**

In `src/app/CreateMenu.tsx`, replace the `<Button variant="primary" ...>`
trigger with:

```tsx
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-[9px] rounded-md border border-n-200 bg-n-0 px-2 text-left text-sm font-medium text-n-800 hover:bg-n-100"
      >
        <Icon name="plus" size={15} color="var(--n-500)" />
        New
      </button>
```

and change the popover class from `right-0 top-full` to `left-0 top-full`
(same width). The aria effect that decorates the first `<button>` in the
trigger keeps working. Remove the now-unused `Button` import.

- [ ] **Step 3: Sidebar header + New button**

Replace the header block (vault-name `<h2>` + collapse) with:

```tsx
      <div className="flex items-center gap-2 py-3 pl-3.5 pr-2.5">
        <span
          data-testid="vault-tile"
          title={vaultName}
          className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md bg-cortex-500 text-xs font-bold text-n-0"
        >
          {vaultName.charAt(0).toUpperCase()}
        </span>
        <span className="text-[15px] font-bold tracking-[-0.02em] text-n-900">
          cerebro<span className="text-synapse-500">.</span>
        </span>
        <span className="flex-1" />
        {/* The one AI act in the chrome — synapse, and a toggle, not a door. */}
        <button
          type="button"
          aria-label="Assistant"
          aria-pressed={aiPanelOpen}
          onClick={() => setAiPanelOpen(!aiPanelOpen)}
          className={`flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md border-0 ${aiPanelOpen ? 'bg-surface-selected' : 'bg-transparent'} hover:bg-n-100`}
        >
          <Icon name="zap" size={15} color="var(--synapse-500)" />
        </button>
        <button
          type="button"
          aria-label="Search"
          title="Search  ⌘K"
          onClick={() => setQuickOpen(true)}
          className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-600 hover:bg-n-100 hover:text-n-900"
        >
          <Icon name="search" size={15} />
        </button>
        <button
          type="button"
          aria-label="Hide sidebar"
          data-testid="sidebar-collapse"
          onClick={() => setCollapsed(true)}
          className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name="panel-left" size={15} />
        </button>
      </div>
```

Delete the standalone Search row. At the top of the scroll area, mount the
New button: `<div className="mb-2"><CreateMenu /></div>` (import it).

- [ ] **Step 4: Primary rows — new order, hot Inbox, My work, Library**

`SurfaceRow` gains a `hot` prop; the count span's class becomes:

```tsx
  className={`ml-auto [font-family:var(--font-mono)] text-2xs tabular-nums ${hot ? 'text-cortex-600' : 'text-n-500'}`}
```

First `nav-surfaces` container becomes, in order: Inbox (`hot`, existing
count), Home, My work:

```tsx
          <SurfaceRow
            icon="circle-check"
            label="My work"
            active={selection.kind === 'mywork'}
            count={openCount}
            onClick={() => navigate({ kind: 'mywork' })}
          />
```

with, beside the `queued` memo:

```ts
  const openCount = useMemo(() => openWork(entries, schema).length, [entries, schema]);
```

(import `openWork` from `@/engine/myWork`). Then the Work / Studio / Base
groups unchanged, then a final container with History and Library:

```tsx
          <SurfaceRow
            icon="blocks"
            label="Library"
            active={selection.kind === 'library'}
            onClick={() => navigate({ kind: 'library' })}
          />
```

Remove the Agents `SurfaceRow` and its nested group (rebuilt as a section in
Step 5).

- [ ] **Step 5: Sections — Collections, Pages, Agents, Databases, Favorites**

Replace the `SECTION_LABEL` headers with `SectionHeader` (import it), reorder
to Collections → Pages → Agents → Databases → Favorites, and key the new
section states off `navClosed` via the existing `groupOpen`/`chevronFor`
helpers (keys: `collections`, `pages`, `agents`, `favorites`; Databases keeps
`typesOpen`).

Collections:

```tsx
        <SectionHeader
          label="Collections"
          open={groupOpen('collections')}
          onToggle={() => setNavGroupOpen('collections', !groupOpen('collections'))}
          actions={[
            { icon: 'plus', label: 'New collection', testId: 'new-collection', onClick: () => setCollectionDialog({ mode: 'new' }) },
          ]}
        />
        {groupOpen('collections') && ( /* existing empty-state + CollectionTree, unchanged */ )}
```

(The old `new-collection` button dies; its testid rides the header action —
`SectionAction.testId`, defined in Task 5 — because e2e reaches for it.)

Pages (with the Task 6.1 ref):

```tsx
        const pagesCreate = useRef<{ newPage(): void; newFolder(): void } | null>(null);
        ...
        <SectionHeader
          label="Pages"
          open={groupOpen('pages')}
          onToggle={() => setNavGroupOpen('pages', !groupOpen('pages'))}
          actions={[
            { icon: 'folder-plus', label: 'New folder', onClick: () => pagesCreate.current?.newFolder() },
            { icon: 'file-plus', label: 'New page', onClick: () => pagesCreate.current?.newPage() },
          ]}
        />
        {groupOpen('pages') && (
          <FileTree
            root=""
            docsOnly
            showCreateBar={false}
            createRef={pagesCreate}
            activePath={selection.kind === 'doc' ? selection.path : null}
            onOpen={openPath}
          />
        )}
```

Agents (the section replacing the destination group; rows keep their testids
and stay outside `nav-surfaces`):

```tsx
        <SectionHeader
          label="Agents"
          open={groupOpen('agents')}
          onToggle={() => setNavGroupOpen('agents', !groupOpen('agents'))}
          actions={[
            { icon: 'arrow-up-right', label: 'Open all agents', onClick: () => navigate({ kind: 'agents' }) },
            { icon: 'plus', label: 'New agent', onClick: () => navigate({ kind: 'library', tab: 'agent' }) },
          ]}
        />
        {groupOpen('agents') && (
          <div data-section="nav-agents">
            {agents.map(({ ref, paused }) => {
              const on = selection.kind === 'agents' && selection.actor === ref.actor;
              return (
                <button
                  key={ref.path}
                  type="button"
                  data-testid="nav-agent"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => navigate({ kind: 'agents', actor: ref.actor })}
                  className={`${rowClass(on)}${paused && !on ? ' text-n-500' : ''}`}
                >
                  <Icon name="bot" size={15} color={paused ? 'var(--n-400)' : 'var(--synapse-500)'} />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{ref.title}</span>
                  {paused && (
                    <span className="ml-auto inline-flex text-n-400">
                      <Icon name="pause" size={12} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
```

with the memo reshaped to carry paused (import `isPaused` from
`@/engine/jobs`):

```ts
  const agents = useMemo(
    () => entries.filter(isAgentEntry).map((e) => ({ ref: agentRef(e), paused: isPaused(e) })),
    [entries],
  );
```

The old in-group "New agent" row dies (the header ＋ owns it now).

Databases: keep `typesOpen` as the open state, render through
`SectionHeader` with the wand and plus as actions:

```tsx
        <SectionHeader
          label="Databases"
          open={typesOpen}
          onToggle={() => setTypesOpen(!typesOpen)}
          actions={[
            { icon: 'wand-sparkles', label: 'Adopt vault schema', onClick: () => setAdopting(true) },
            { icon: 'plus', label: 'New database', onClick: () => setTypeDialog({ mode: 'new' }) },
          ]}
        />
```

(type rows unchanged).

Favorites, last:

```tsx
        <SectionHeader
          label="Favorites"
          open={groupOpen('favorites')}
          onToggle={() => setNavGroupOpen('favorites', !groupOpen('favorites'))}
        />
        {groupOpen('favorites') &&
          (favoriteRows.length === 0 ? (
            <div className="px-2 py-1 text-xs text-n-400">No favorites yet</div>
          ) : (
            favoriteRows.map(({ entry, icon, color, onOpen }) => (
              <button
                key={entry.path}
                type="button"
                data-testid="nav-favorite"
                onClick={onOpen}
                className={rowClass(false)}
              >
                <Icon name={icon} size={15} color={color} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{entry.title}</span>
              </button>
            ))
          ))}
```

backed by:

```ts
  const favorites = useUiStore((s) => s.favorites);
  const pruneFavorites = useUiStore((s) => s.pruneFavorites);
  const favoriteRows = useMemo(() => {
    const byPath = new Map(entries.map((e) => [e.path, e]));
    return favorites.flatMap((path) => {
      const entry = byPath.get(path);
      if (entry === undefined) return []; // pruned below — a pointer, not a record
      if (isAgentEntry(entry)) {
        const ref = agentRef(entry);
        return [{ entry, icon: 'bot', color: 'var(--synapse-500)', onOpen: () => navigate({ kind: 'agents', actor: ref.actor }) }];
      }
      const style = entry.type !== null ? typeStyle(entry.type, schema) : null;
      return [{
        entry,
        icon: style?.icon ?? 'file-text',
        color: style?.color ?? 'var(--n-500)',
        onOpen: () => openPath(entry.path),
      }];
    });
  }, [favorites, entries, schema, navigate, openPath]);
  useEffect(() => {
    pruneFavorites(new Set(entries.map((e) => e.path)));
  }, [entries, pruneFavorites]);
```

(import `typeStyle` from `@/engine/typeCatalog`.)

- [ ] **Step 6: Footer — SyncBadge · Theme · Settings**

Replace the footer block with:

```tsx
      <div
        data-testid="nav-surfaces"
        className="flex flex-none items-center gap-0.5 border-t border-n-200 px-2 py-1.5"
      >
        <SyncBadge />
        <button
          type="button"
          onClick={cycleTheme}
          title={`Theme: ${themeMode}`}
          className="flex h-[30px] flex-1 items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-xs text-n-600 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name={THEME_ICONS[themeMode]} size={15} />
          Theme
        </button>
        <button
          type="button"
          aria-current={selection.kind === 'settings' ? 'page' : undefined}
          onClick={() => navigate({ kind: 'settings' })}
          className={`flex h-[30px] flex-1 items-center gap-2 rounded-md border-0 px-2 text-left text-xs ${selection.kind === 'settings' ? 'bg-surface-selected font-medium text-cortex-700' : 'bg-transparent text-n-600 hover:bg-n-100 hover:text-n-800'}`}
        >
          <Icon name="settings" size={15} />
          Settings
        </button>
      </div>
```

with, at module scope and in the component:

```ts
const THEME_ICONS: Record<ThemeMode, string> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
...
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const cycleTheme = () => setThemeMode(THEME_NEXT[themeMode]);
```

(import `type ThemeMode` from `@/stores/uiStore`; import `SyncBadge` from
`@/git/SyncBadge`). The Assistant and Library rows are gone from the footer
(zap and primary row own them).

- [ ] **Step 7: Rewrite `Sidebar.test.tsx` deliberately**

Every churned name is a conscious edit:
- Names assertion → rows: `['Inbox', 'Home', 'My work', 'Work', 'Studio', 'Base', 'History', 'Library', 'Settings']`
  (Agents asserted separately as a section: `getByRole('button', { name: 'Agents' })`
  with `aria-expanded`, not `aria-current`).
- Assistant test → the zap: same queries (`name: 'Assistant'`, `aria-pressed`)
  still pass; keep the test, update its comment.
- Agents-group tests → section shape: chevron test becomes "the Agents header
  folds the section"; the "New agent" row expectation moves to the header's
  hover action (`getByRole('button', { name: 'New agent' })`).
- Add: My work count test (seed a Task type + one active record via the
  test's existing store-seeding pattern, expect `name: 'My work (1)'`).
- Add: Favorites empty state (`No favorites yet`), one pinned row, and the
  pruning of a dead path.
- Vault-name heading assertions → the `vault-tile` title.

- [ ] **Step 8: Run the suite**

Run: `pnpm vitest run src/app/Sidebar.test.tsx src/app/CreateMenu.test.tsx src/components/FileTree.test.tsx && pnpm typecheck`
Expected: PASS. (FileTree's test file may live elsewhere — `pnpm vitest run src/components` if so.)

- [ ] **Step 9: Commit**

```bash
git add -A src/app src/components/FileTree.tsx
git commit -m "feat(shell): the sidebar speaks the whole design — sections, My work, favorites, footer (M43.6)"
```

---

### Task 7: The Topbar dissolves (M43.7)

**Files:**
- Delete: `src/app/Topbar.tsx`
- Modify: `src/App.tsx` (remove import + render; `relative` on the shell root)
- Modify: `src/app/Sidebar.tsx` (collapsed state → floating cluster)
- Modify: `src/App.test.tsx` (whatever asserted the Topbar)

- [ ] **Step 1: Collapsed sidebar becomes the floating cluster**

Replace Sidebar's `if (collapsed)` return with:

```tsx
  if (collapsed) {
    return (
      <div className="absolute left-2.5 top-2.5 z-20 flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Show sidebar"
          data-testid="sidebar-expand"
          onClick={() => setCollapsed(false)}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 bg-transparent text-n-600 hover:bg-n-100 hover:text-n-900"
        >
          <Icon name="panel-left" size={15} />
        </button>
        <button
          type="button"
          aria-label="Assistant"
          aria-pressed={aiPanelOpen}
          onClick={() => setAiPanelOpen(!aiPanelOpen)}
          className={`flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 ${aiPanelOpen ? 'bg-surface-selected' : 'bg-transparent'} hover:bg-n-100`}
        >
          <Icon name="zap" size={15} color="var(--synapse-500)" />
        </button>
        <button
          type="button"
          aria-label="Search"
          title="Search  ⌘K"
          onClick={() => setQuickOpen(true)}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 bg-transparent text-n-600 hover:bg-n-100 hover:text-n-900"
        >
          <Icon name="search" size={15} />
        </button>
      </div>
    );
  }
```

- [ ] **Step 2: App.tsx**

- Add `relative` to the shell root: `className="relative flex h-screen overflow-hidden bg-n-0 text-sm leading-5 text-n-900"`.
- Delete the `Topbar` import and the `<Topbar />` line.
- Delete `src/app/Topbar.tsx` (`git rm src/app/Topbar.tsx`).

- [ ] **Step 3: Sweep the fallout**

Run: `grep -rn 'Topbar' src/ e2e/` — expected leftovers are `App.test.tsx`
assertions and possibly comments referencing "Topbar" (App.tsx's layout
comment mentions it — reword it: a retired workaround needs its original
comment killed). Update `App.test.tsx` to assert the new chrome (wordmark now
in the sidebar; QuickOpen still opens on ⌘K).

- [ ] **Step 4: Run the suite**

Run: `pnpm test:run && pnpm typecheck && pnpm lint`
Expected: PASS. Coverage may need new tests if the ratchet complains —
Sidebar/App tests from Tasks 6–7 should cover the new branches; add targeted
cases rather than lowering anything.

- [ ] **Step 5: Commit**

```bash
git add -A src/App.tsx src/App.test.tsx src/app
git commit -m "feat(shell): the Topbar dissolves — the sidebar is the chrome (M43.7)"
```

---

### Task 8: e2e sweep + full gates (M43.8)

**Files:**
- Modify: `e2e/*.spec.ts` as the failures direct (smoke, agents, inbox,
  knowledge, studio at minimum — they navigate via sidebar rows)

- [ ] **Step 1: Check the port is FREE**

Run: `lsof -iTCP:5173 -sTCP:LISTEN`
If held by another worktree: `PORT=5273 pnpm e2e` for every run below.

- [ ] **Step 2: Run and repair**

Run: `pnpm e2e`
Expected first run: failures wherever specs assumed the Topbar (`Search or
ask`, create-menu position), the Agents destination row, or the old footer.
Repair patterns:
- Destination clicks stay scoped to `nav-surfaces`; the Agents fleet is now
  reached via the section's ↗ (`getByRole('button', { name: 'Open all agents' })` —
  hover the section header first, or rely on focus-visible).
- The create menu opens from the sidebar's New button (same `role="menu"`).
- Never assert against `docs/archive`/vendored trees; only our specs change.

- [ ] **Step 3: Full gate**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test:run && pnpm e2e && (cd src-tauri && cargo test)`
Expected: all green (Rust untouched but the gate proves it).

- [ ] **Step 4: Commit**

```bash
git add -A e2e
git commit -m "test(e2e): the specs walk the one-column chrome (M43.8)"
```

---

### Task 9: Fold the delivery into the docs (M43.9)

**Files:**
- Modify: `AGENTS.md` (the shell paragraph: ten destinations → the new shape;
  the "ten names are asserted" sentence; the Topbar SyncBadge reference in
  the M9.4 line if present)

- [ ] **Step 1: Update AGENTS.md**

Rewrite the shell bullet to describe: one nav column that IS the chrome (no
Topbar since M43); primary rows Inbox/Home/My work/Work/Studio/Base/History/
Library; Agents/Collections/Pages/Databases/Favorites as sections sharing the
SectionHeader anatomy; footer SyncBadge · Theme · Settings; zap = Assistant.
Keep the labels-spend-kinds-stay sentence and add `mywork` to the kind note.

- [ ] **Step 2: Kill falsified comments**

Run: `grep -rn 'Topbar\|ten destinations' src/ AGENTS.md` — any comment the
milestone falsified dies in this commit (the M31 rule: the comment a change
falsifies is rarely the comment the change is about).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md src/
git commit -m "docs(shell): fold M43 into AGENTS.md — the sidebar is the chrome (M43.9)"
```
