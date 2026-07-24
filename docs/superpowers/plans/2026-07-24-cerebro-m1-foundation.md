# Cerebro M1 — Foundation Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Cerebro desktop app: Tauri v2 shell in the Cerebro design language, opening a markdown vault with a typed-lenses schema engine, spaces → projects → work items rendered in List and Board views with grouping, a schema-driven detail panel, and a demo vault generated from the prototype seed data.

**Architecture:** Files-first — a Rust scanner parses a folder of markdown files into `Entry` records; zustand stores hold them; a pure-TS `SchemaRegistry` derives types, per-space status sets, and field resolvers; a collections layer maps sidebar selections to `{entries, presentation}` rendered by List/Board through one shared grouping engine. All writes are disk-first via Tauri IPC (with an in-memory mock IPC for browser dev and tests). Spec: [docs/superpowers/specs/2026-07-24-cerebro-m1-foundation-design.md](../specs/2026-07-24-cerebro-m1-foundation-design.md).

**Tech Stack:** Tauri v2 (Rust: serde_yaml, walkdir, notify, tauri-plugin-dialog) · React 19 + TypeScript 5.9 + Vite 7 + pnpm · Tailwind CSS v4 (`@tailwindcss/vite`) with Cerebro DS tokens · zustand 5 · yaml 2 · lucide-react · @dnd-kit/core · Vitest 3 + Testing Library · Playwright (browser mode against mock IPC).

---

## Conventions (read before any task)

- **Working branch:** create `m1-foundation` off `main` before Task 1; every task commits to it.
- **Commits:** conventional prefixes (`feat:`, `test:`, `chore:`, `fix:`), one commit per task minimum, exactly as each task's final step specifies.
- **TDD:** every logic task writes the failing test first, runs it to see it fail, implements minimally, runs it green, commits. UI tasks include component tests with Testing Library where behavior warrants it; purely compositional JSX is verified by the dev server + smoke test.
- **Commands:** `pnpm vitest run <path>` (unit), `cargo test --manifest-path src-tauri/Cargo.toml` (Rust), `pnpm dev` (browser mode w/ mock IPC), `pnpm tauri dev` (real shell), `pnpm exec playwright test` (smoke).
- **Files:** TS modules camelCase (`schema.ts`), components PascalCase (`BoardView.tsx`), tests colocated as `<name>.test.ts(x)`. Path alias `@/` → `src/`.
- **Styling:** Tailwind utilities + Cerebro token CSS variables (`var(--n-100)` etc. via arbitrary values or the `@theme` bridge). Light mode only. Lucide icons stroke 1.75. No gradients, sentence case copy, no emoji (DS hard rules).
- **No new dependencies** beyond the versions table below without noting it as a deviation.

## File structure (target state after M1)

```
package.json  vite.config.ts  tsconfig.json  index.html  playwright.config.ts
src/
  main.tsx  App.tsx
  styles/index.css            # imports tokens, @theme bridge, app-level styles
  styles/tokens/*.css         # copied from docs/Cerebro Design System/tokens/
  assets/fonts/*              # Instrument Sans, IBM Plex Mono from DS
  lib/ipc.ts  lib/mockIpc.ts  lib/mockParse.ts  lib/quickOpenScore.ts  lib/slug.ts  lib/swatch.ts
  engine/types.ts  wikilink.ts  normalize.ts  schema.ts  grouping.ts
         itemKeys.ts  viewFilters.ts  views.ts  collections.ts
  stores/vaultStore.ts  navStore.ts  uiStore.ts
  engine/testHelpers.ts  test/factories.ts       # shared test fixtures
  components/ui/              # ported DS primitives (Button, Select, Dialog, ...)
  app/Rail.tsx  Topbar.tsx  Sidebar.tsx  QuickOpen.tsx  CreateMenu.tsx  ToastHost.tsx
  pages/HomePage.tsx  SpacePage.tsx  ProjectPage.tsx  SettingsPage.tsx
  views/ViewToolbar.tsx  ListView.tsx  BoardView.tsx  FieldChip.tsx
  detail/DetailPanel.tsx  FieldEditor.tsx  FieldPopover.tsx
src-tauri/
  Cargo.toml  tauri.conf.json  build.rs
  src/main.rs  lib.rs  app_config.rs
  src/vault/mod.rs  entry.rs  parse.rs  scan.rs  write.rs  watcher.rs
scripts/build-demo-vault.ts
demo-vault/                   # generated, committed
e2e/smoke.spec.ts
```

## Dependency versions

`react`/`react-dom` ^19.1 · `typescript` ~5.9 · `vite` ^7 · `@vitejs/plugin-react` ^5 · `tailwindcss` + `@tailwindcss/vite` ^4.1 · `zustand` ^5 · `yaml` ^2.8 · `lucide-react` ^0.525 · `@dnd-kit/core` ^6.3 · `@tauri-apps/api` ^2 · `@tauri-apps/cli` ^2 · `@tauri-apps/plugin-dialog` ^2 · `vitest` ^3.2 · `jsdom` ^26 · `@testing-library/react` ^16.3 · `@testing-library/user-event` ^14 · `tsx` ^4 · `@playwright/test` ^1.54. Rust crates: `tauri = "2"`, `serde = 1` (derive), `serde_json = 1`, `serde_yaml = "0.9"`, `walkdir = "2"`, `notify = "6"`, `tauri-plugin-dialog = "2"`, `chrono = "0.4"`.

## Shared contracts

All tasks use these names exactly. Deviating from a signature here without updating this section is a plan bug.

### `src/engine/types.ts` (authoritative)

```ts
export type Scalar = string | number | boolean | null;

export interface Entry {
  path: string;                 // vault-relative, e.g. "items/fld-7.md"
  filename: string;             // "fld-7.md"
  title: string;                // first H1, else humanized filename stem
  type: string | null;          // frontmatter `type`
  properties: Record<string, Scalar | Scalar[]>;   // scalar frontmatter (non-wikilink); nested YAML
                                                   // (type-note `fields:`, space `statuses:`) passes
                                                   // through as raw nested values — consumers cast
  relationships: Record<string, string[]>;         // wikilink-valued fields → raw targets
  outgoingLinks: string[];      // wikilink targets found in the body
  snippet: string;              // first ~160 chars of body text, markdown-stripped
  createdAt: string;            // ISO 8601
  modifiedAt: string;           // ISO 8601
  parseError: string | null;    // YAML error message, or null
}

export type FieldKind =
  | 'text' | 'number' | 'checkbox' | 'date' | 'daterange'
  | 'select' | 'multiselect' | 'status' | 'person' | 'relation';

export interface FieldOption { id: string; label: string; color: string | null; hollow?: boolean }
export interface StatusDef extends FieldOption { group: 'active' | 'done' | 'closed' }
export interface FieldDef { name: string; kind: FieldKind; options?: FieldOption[]; target?: string }
export interface TypeDef { name: string; icon: string | null; color: string | null; fields: FieldDef[] }

export interface ResolvedField {
  def: FieldDef | null;         // null → undeclared field (advisory: still shown as text)
  raw: unknown;
  display: string;              // '' when empty
  color: string | null;
  ghost: boolean;               // value not in the declared option set
}

export type Selection =
  | { kind: 'home' }
  | { kind: 'space'; path: string }
  | { kind: 'project'; path: string }
  | { kind: 'view'; id: string }       // id = filename stem in views/
  | { kind: 'settings' };

export interface Presentation {
  type: 'list' | 'board';
  groupBy: string | null;              // field name; null = flat list
  orderBy: { field: string; dir: 'asc' | 'desc' };
  visibleFields: string[];
}

export type FilterOp =
  | 'equals' | 'not_equals' | 'contains' | 'any_of' | 'none_of'
  | 'is_empty' | 'is_not_empty' | 'before' | 'after';
export interface FilterRule { field: string; op: FilterOp; value?: Scalar | Scalar[] }
export type FilterGroup = { all: (FilterRule | FilterGroup)[] } | { any: (FilterRule | FilterGroup)[] };

export interface ViewDefinition {
  name: string; icon: string | null; color: string | null; order: number | null;
  filters: FilterGroup | null; presentation: Presentation;
}
export interface ViewFile { id: string; definition: ViewDefinition }

export interface Group { key: string; label: string; color: string | null; ghost: boolean; entries: Entry[] }
// groupEntries emits empty declared option/status groups (boards need the columns) and a trailing
// no-value group with key '__none__' (label 'No <field>') — pinned; BoardView/ListView rely on it.

export interface Schema {
  types: Map<string, TypeDef>;
  spaceForEntry(e: Entry): Entry | null;                    // item → project → space (via relationships)
  statusSetForSpace(spacePath: string | null): StatusDef[]; // null/space w/o statuses → DEFAULT_STATUSES
  resolveField(e: Entry, field: string): ResolvedField;
}
```

### Engine functions (pure, unit-tested)

```ts
// wikilink.ts
parseWikilinks(value: unknown): string[] | null       // null if value contains no [[..]]
formatWikilink(target: string): string                // '[[target]]'
resolveTarget(target: string, entries: Entry[]): Entry | null  // stem match, then title match, case-insensitive
// schema.ts
buildSchema(entries: Entry[]): Schema
DEFAULT_STATUSES: StatusDef[]   // simple template: backlog/todo/in-progress/done/cancelled per spec colors
// grouping.ts
groupEntries(entries: Entry[], field: string, schema: Schema): Group[]
// itemKeys.ts
nextItemKey(prefix: string, entries: Entry[]): string  // 'FLD-8'
// viewFilters.ts
evaluateFilters(entry: Entry, group: FilterGroup, schema: Schema): boolean
// views.ts
parseViewYaml(id: string, yaml: string): ViewFile      // tolerant: bad yaml → default presentation, name = id
serializeView(def: ViewDefinition): string
// collections.ts
resolveCollection(sel: Selection, entries: Entry[], schema: Schema, views: ViewFile[]):
  { title: string; entries: Entry[]; presentation: Presentation }
// lib/quickOpenScore.ts
quickOpenScore(query: string, candidate: string): number  // 0 = no match; higher = better
```

### IPC surface — `src/lib/ipc.ts` (TS) ↔ Tauri commands (Rust)

Rust structs serialize `rename_all = "camelCase"` to match `Entry` exactly.

| Command | Signature (TS) | Notes |
|---|---|---|
| `pick_vault` | `pickVault(): Promise<string \| null>` | dialog; persists choice via app config |
| `get_last_vault` | `getLastVault(): Promise<string \| null>` | from app config JSON |
| `scan_vault` | `scanVault(vault: string): Promise<Entry[]>` | full rescan |
| `read_note` | `readNote(vault: string, path: string): Promise<string>` | body only (frontmatter stripped) |
| `save_note` | `saveNote(vault: string, path: string, body: string): Promise<void>` | replaces body, preserves frontmatter |
| `update_frontmatter` | `updateFrontmatter(vault: string, path: string, patch: Record<string, unknown>): Promise<void>` | `null` value deletes key; preserves key order + unknown keys |
| `create_note` | `createNote(vault: string, folder: string, slug: string, frontmatter: Record<string, unknown>, body: string): Promise<string>` | returns vault-relative path; dedupes slug with `-2`, `-3`… |
| `set_note_title` | `setNoteTitle(vault: string, path: string, title: string): Promise<void>` | rewrites first H1 (inserts if absent) |
| `list_views` | `listViews(vault: string): Promise<{id: string; yaml: string}[]>` | raw YAML; parsing happens in TS |
| `save_view` | `saveView(vault: string, id: string, yaml: string): Promise<void>` | writes `views/<id>.yml` |
| `start_watcher` | `startWatcher(vault: string): Promise<void>` | emits `vault-changed` event; 350ms debounce, 4s own-write suppression |

`ipc.ts` exports these functions; it delegates to Tauri `invoke` when running inside Tauri, else to `mockIpc.ts` (in-memory Map seeded from `demo-vault/` via `import.meta.glob(..., { query: '?raw' })`; exposes `window.__cerebroMockFs` for tests).

### Store APIs (zustand)

```ts
// stores/vaultStore.ts
interface VaultState {
  vaultPath: string | null;
  entries: Entry[];
  views: ViewFile[];
  status: 'idle' | 'scanning' | 'ready' | 'error';
  error: string | null;
  openVault(path: string): Promise<void>;      // scan + list views + start watcher
  rescan(): Promise<void>;
  patchFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>; // optimistic + disk write
  createItem(args: { folder: string; slug: string; frontmatter: Record<string, unknown>; body?: string }): Promise<string>;
}
// selector helpers exported alongside: useEntry(path), useSchema() (memoized buildSchema)

// stores/navStore.ts
interface NavState {
  selection: Selection;                        // initial: { kind: 'home' }
  history: Selection[]; historyIndex: number;
  navigate(sel: Selection): void; back(): void; forward(): void;
}

// stores/uiStore.ts
interface UiState {
  detailPath: string | null; openDetail(path: string): void; closeDetail(): void;
  quickOpenVisible: boolean; setQuickOpen(v: boolean): void;
  toasts: { id: number; message: string }[]; toast(message: string): void; dismissToast(id: number): void;
}
```

### View component contracts (Task 19 placeholders → Tasks 20/21 real implementations)

```ts
// src/views/ListView.tsx — root element keeps data-testid="list-view"
export interface ListViewProps { entries: Entry[]; presentation: Presentation; schema: Schema; project: Entry | null }
// src/views/BoardView.tsx — root element keeps data-testid="board-view"
export interface BoardViewProps { entries: Entry[]; presentation: Presentation; schema: Schema }
```

### Rust `Entry` (src-tauri/src/vault/entry.rs)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub filename: String,
    pub title: String,
    #[serde(rename = "type")] pub entry_type: Option<String>,
    pub properties: serde_json::Map<String, serde_json::Value>,
    pub relationships: std::collections::BTreeMap<String, Vec<String>>,
    pub outgoing_links: Vec<String>,
    pub snippet: String,
    pub created_at: String,
    pub modified_at: String,
    pub parse_error: Option<String>,
}
```

## Cross-task coordination notes

Decisions reconciled across task authors — binding on executors:

- `src/engine/types.ts` is **created in Task 10** verbatim from the Shared contracts above (Task 12 carries a defensive fallback if it is missing). Task 11 creates clearly-marked placeholder `src/engine/schema.ts` / `src/engine/views.ts` so the store compiles; Tasks 13/15 replace them.
- Task 19 creates placeholder `src/views/ListView.tsx` / `BoardView.tsx` with the exact props and `data-testid`s from the View component contracts; Tasks 20/21 replace the bodies but keep both.
- `src/lib/mockParse.ts` (Task 10) is deliberately self-contained (does not import `engine/normalize.ts`, which arrives in Task 12); cross-language parity with the Rust parser is guarded by 3 shared fixtures in `mockParse.test.ts` — when executing Task 4, mirror those fixture strings/expectations in the Rust tests.
- Work item type name is exactly `Work item` (item frontmatter `type: Work item`; demo vault type note `type/work-item.md` titled `# Work item`).
- Task 1 declares the **full** Rust crate set in Cargo.toml (so Tasks 4–8 never edit it) and pins `[lib] name = "cerebro_lib"`; `@types/react`/`@types/react-dom` are devDependencies (additions to the version table). `App.tsx` uses a default export.
- Task 23 embeds the three STATUS_TEMPLATES verbatim from the prototype's `STATUS_PRESETS` (`name` renamed to `label`). Task 24 adds an optional `testId` pass-through to the Task 3 `SegmentedControl` and a Vitest `exclude: ['e2e/**']`.
- `vaultStore.rescan()` refreshes **both** entries and views (Task 11 implements it that way; Task 19's Save view relies on it).

## Task index

| # | Task | Produces |
|---|---|---|
| 1 | Scaffold app (Vite + React + TS + Tailwind 4 + Vitest + Tauri shell) | `pnpm dev` renders a styled placeholder; `pnpm vitest run` green |
| 2 | Cerebro tokens, fonts, base styles, `@theme` bridge | token variables usable in Tailwind |
| 3 | Port DS primitives to `src/components/ui/` | Button, IconButton, Icon, Input, Select, Avatar, Badge, Tag, FilterChip, SegmentedControl, Dialog, Tooltip, Toast, EmptyState, KanbanCard, StatusFlag, ProgressBar |
| 4 | Rust: frontmatter parse + Entry extraction (`parse.rs`, `entry.rs`) | tested parser (H1 title, relationships, properties, parse errors) |
| 5 | Rust: vault scanner (`scan.rs`) on fixture vault | tested `scan_vault` |
| 6 | Rust: writes (`write.rs`): update_frontmatter / save_note / create_note / set_note_title / views | tested round-trip preserving unknown keys + order |
| 7 | Rust: app config + Tauri command wiring + dialog (`app_config.rs`, `lib.rs`) | all IPC commands invokable |
| 8 | Rust: watcher (`watcher.rs`) with debounce + own-write suppression | `vault-changed` events |
| 9 | Demo vault generator (`scripts/build-demo-vault.ts`) + committed `demo-vault/` | Meridian org as markdown |
| 10 | `ipc.ts` + `mockIpc.ts` (browser mode) | app runs without Rust |
| 11 | `vaultStore` with optimistic patch + `useSchema` selector | tested store |
| 12 | Engine: `wikilink.ts` + `normalize.ts` | tested |
| 13 | Engine: `schema.ts` (buildSchema, statusSetForSpace, resolveField, DEFAULT_STATUSES) | tested |
| 14 | Engine: `grouping.ts` | tested |
| 15 | Engine: `views.ts` + `viewFilters.ts` | tested |
| 16 | Engine: `itemKeys.ts` + `lib/quickOpenScore.ts` | tested |
| 17 | Shell: `navStore` + `uiStore` + Rail/Topbar/Sidebar frame + boot flow (last vault / demo offer) | navigable shell |
| 18 | Sidebar spaces tree + views section + HomePage | prototype home |
| 19 | SpacePage + ProjectPage + ViewToolbar (view switch, group-by, order, Save view) | project surface |
| 20 | ListView (grouped sections, rows, field chips, quick-add) | working list |
| 21 | BoardView (columns, cards, dnd-kit drag → frontmatter write) | working board |
| 22 | DetailPanel (schema-driven editors, popovers, description textarea, H1 rename) | working detail |
| 23 | QuickOpen (⌘K) + CreateMenu + SettingsPage + ToastHost | complete M1 chrome |
| 24 | Playwright smoke (browser mode + mock IPC) | end-to-end proof |

---

### Task 1: Project scaffold — Vite + React + TS + Tailwind 4 + Vitest + Tauri v2 shell

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/styles/index.css` (minimal; fully rewritten in Task 2)
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Modify: `.gitignore`
- Test: `src/App.test.tsx`

All commands run from the repo root `/Users/joseflagorio/Development/cerebro`.

- [ ] **Step 1: Create the working branch**

  Run: `git checkout -b m1-foundation`
  Expected: `Switched to a new branch 'm1-foundation'`

- [ ] **Step 2: Write `package.json`**

  ```json
  {
    "name": "cerebro",
    "private": true,
    "version": "0.1.0",
    "type": "module",
    "scripts": {
      "dev": "vite",
      "build": "tsc --noEmit && vite build",
      "preview": "vite preview",
      "test": "vitest",
      "tauri": "tauri"
    },
    "dependencies": {
      "@dnd-kit/core": "^6.3.1",
      "@tauri-apps/api": "^2.6.0",
      "@tauri-apps/plugin-dialog": "^2.3.0",
      "lucide-react": "^0.525.0",
      "react": "^19.1.0",
      "react-dom": "^19.1.0",
      "yaml": "^2.8.0",
      "zustand": "^5.0.6"
    },
    "devDependencies": {
      "@playwright/test": "^1.54.0",
      "@tailwindcss/vite": "^4.1.11",
      "@tauri-apps/cli": "^2.6.0",
      "@testing-library/react": "^16.3.0",
      "@testing-library/user-event": "^14.6.1",
      "@types/react": "^19.1.0",
      "@types/react-dom": "^19.1.0",
      "@vitejs/plugin-react": "^5.0.0",
      "jsdom": "^26.1.0",
      "tailwindcss": "^4.1.11",
      "tsx": "^4.20.0",
      "typescript": "~5.9.0",
      "vite": "^7.0.0",
      "vitest": "^3.2.4"
    }
  }
  ```

  (`@types/react` / `@types/react-dom` are not in the plan's version table but are required for TSX compilation — accepted implicit addition.)

- [ ] **Step 3: Write `vite.config.ts`**

  ```ts
  /// <reference types="vitest/config" />
  import { defineConfig } from 'vite';
  import react from '@vitejs/plugin-react';
  import tailwindcss from '@tailwindcss/vite';
  import { fileURLToPath, URL } from 'node:url';

  export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    clearScreen: false,
    server: { port: 5173, strictPort: true },
    test: {
      environment: 'jsdom',
      globals: true,
    },
  });
  ```

- [ ] **Step 4: Write `tsconfig.json`**

  `vite.config.ts` is deliberately excluded from `include` (Vite type-checks it itself; keeps `@types/node` out of the dependency set).

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "moduleResolution": "bundler",
      "jsx": "react-jsx",
      "strict": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "noEmit": true,
      "skipLibCheck": true,
      "isolatedModules": true,
      "resolveJsonModule": true,
      "useDefineForClassFields": true,
      "types": ["vite/client", "vitest/globals"],
      "baseUrl": ".",
      "paths": { "@/*": ["src/*"] }
    },
    "include": ["src"]
  }
  ```

- [ ] **Step 5: Write `index.html`, `src/styles/index.css`, `src/main.tsx`**

  `index.html`:

  ```html
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Cerebro</title>
    </head>
    <body>
      <div id="root"></div>
      <script type="module" src="/src/main.tsx"></script>
    </body>
  </html>
  ```

  `src/styles/index.css` (placeholder — Task 2 replaces this file entirely):

  ```css
  @import 'tailwindcss';
  ```

  `src/main.tsx`:

  ```tsx
  import React from 'react';
  import ReactDOM from 'react-dom/client';
  import App from './App';
  import './styles/index.css';

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  ```

- [ ] **Step 6: Append build outputs to `.gitignore`**

  Append these lines to the existing `/Users/joseflagorio/Development/cerebro/.gitignore` (which currently only ignores `tolaria-main/`):

  ```gitignore

  # App build artifacts
  node_modules/
  dist/
  src-tauri/target/
  src-tauri/gen/schemas/
  ```

- [ ] **Step 7: Install JS dependencies**

  Run: `pnpm install`
  Expected: lockfile written, no peer-dependency errors.

- [ ] **Step 8: Write the failing sanity test**

  `src/App.test.tsx`:

  ```tsx
  import { render, screen } from '@testing-library/react';
  import { describe, expect, it } from 'vitest';
  import App from './App';

  describe('App', () => {
    it('renders the placeholder heading', () => {
      render(<App />);
      expect(screen.getByRole('heading', { name: 'Cerebro' })).toBeTruthy();
    });
  });
  ```

- [ ] **Step 9: Run test to verify it fails**

  Run: `pnpm vitest run src/App.test.tsx`
  Expected: FAIL — `Cannot find module './App'` (App.tsx does not exist yet). This proves the vitest + jsdom + Testing Library pipeline executes.

- [ ] **Step 10: Write `src/App.tsx` placeholder**

  ```tsx
  export default function App() {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <h1 className="text-2xl font-semibold">Cerebro</h1>
      </main>
    );
  }
  ```

- [ ] **Step 11: Run test to verify it passes**

  Run: `pnpm vitest run src/App.test.tsx`
  Expected: PASS (1 test).

- [ ] **Step 12: Write the Tauri v2 shell — `src-tauri/Cargo.toml` and `src-tauri/build.rs`**

  The full Rust dependency set from the plan's version table is declared now so Tasks 4–8 never touch `Cargo.toml`; only `tauri`/`serde`/`serde_json`/the dialog plugin are exercised in this task.

  `src-tauri/Cargo.toml`:

  ```toml
  [package]
  name = "cerebro"
  version = "0.1.0"
  description = "Cerebro — files-first work management"
  edition = "2021"

  [lib]
  name = "cerebro_lib"
  crate-type = ["staticlib", "cdylib", "rlib"]

  [build-dependencies]
  tauri-build = { version = "2", features = [] }

  [dependencies]
  tauri = { version = "2", features = [] }
  tauri-plugin-dialog = "2"
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  serde_yaml = "0.9"
  walkdir = "2"
  notify = "6"
  chrono = "0.4"
  ```

  `src-tauri/build.rs`:

  ```rust
  fn main() {
      tauri_build::build()
  }
  ```

- [ ] **Step 13: Write `src-tauri/tauri.conf.json` and `src-tauri/capabilities/default.json`**

  `src-tauri/tauri.conf.json`:

  ```json
  {
    "$schema": "https://schema.tauri.app/config/2",
    "productName": "Cerebro",
    "version": "0.1.0",
    "identifier": "com.cerebro.app",
    "build": {
      "beforeDevCommand": "pnpm dev",
      "devUrl": "http://localhost:5173",
      "beforeBuildCommand": "pnpm build",
      "frontendDist": "../dist"
    },
    "app": {
      "windows": [
        {
          "title": "Cerebro",
          "width": 1400,
          "height": 900,
          "resizable": true
        }
      ],
      "security": {
        "csp": null
      }
    },
    "bundle": {
      "active": false
    }
  }
  ```

  `src-tauri/capabilities/default.json`:

  ```json
  {
    "$schema": "../gen/schemas/desktop-schema.json",
    "identifier": "default",
    "description": "Default capability for the main window",
    "windows": ["main"],
    "permissions": ["core:default", "dialog:default"]
  }
  ```

- [ ] **Step 14: Write `src-tauri/src/lib.rs` and `src-tauri/src/main.rs`**

  `src-tauri/src/lib.rs` (hello shell only — vault engine arrives in Tasks 4–8):

  ```rust
  #[cfg_attr(mobile, tauri::mobile_entry_point)]
  pub fn run() {
      tauri::Builder::default()
          .plugin(tauri_plugin_dialog::init())
          .run(tauri::generate_context!())
          .expect("error while running Cerebro");
  }
  ```

  `src-tauri/src/main.rs`:

  ```rust
  #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

  fn main() {
      cerebro_lib::run();
  }
  ```

- [ ] **Step 15: Verify frontend build, then Rust build**

  Run: `pnpm build`
  Expected: `tsc --noEmit` clean, Vite writes `dist/` (this must exist before the Rust build — `generate_context!` embeds `frontendDist`).

  Run: `cargo check --manifest-path src-tauri/Cargo.toml`
  Expected: `Finished` with no errors (first run compiles the tauri crate tree; several minutes is normal).

- [ ] **Step 16: Verify the dev server**

  Run: `pnpm dev` (then open http://localhost:5173, Ctrl-C when done)
  Expected: centered "Cerebro" heading on a white page, no console errors.

- [ ] **Step 17: Commit**

  ```sh
  git add package.json pnpm-lock.yaml vite.config.ts tsconfig.json index.html .gitignore src src-tauri
  git commit -m "chore: scaffold Vite React TS app with Tailwind 4, Vitest, and Tauri v2 shell"
  ```

---

### Task 2: Cerebro DS tokens, fonts, and Tailwind `@theme` bridge

**Files:**
- Create: `src/styles/tokens/colors.css`, `src/styles/tokens/typography.css`, `src/styles/tokens/spacing.css`, `src/styles/tokens/fonts.css`, `src/styles/tokens/base.css` (copied from `docs/Cerebro Design System/tokens/`)
- Create: `src/assets/fonts/InstrumentSans-Variable.ttf`, `src/assets/fonts/InstrumentSans-Italic-Variable.ttf`, `src/assets/fonts/IBMPlexMono-Regular.ttf`, `src/assets/fonts/IBMPlexMono-Medium.ttf`, `src/assets/fonts/IBMPlexMono-SemiBold.ttf` (copied from DS assets)
- Modify: `src/styles/tokens/fonts.css` (fix `url()` paths), `src/styles/index.css` (full rewrite), `src/App.tsx` (styled verification)
- Test: existing `src/App.test.tsx` (must stay green — the heading text "Cerebro" is preserved)

This task is compositional styling; per the conventions, verification is the dev server plus the existing sanity test (no new logic → no new unit test).

- [ ] **Step 1: Copy the five token files**

  Run:

  ```sh
  mkdir -p src/styles/tokens src/assets/fonts
  cp "docs/Cerebro Design System/tokens/colors.css"     src/styles/tokens/colors.css
  cp "docs/Cerebro Design System/tokens/typography.css" src/styles/tokens/typography.css
  cp "docs/Cerebro Design System/tokens/spacing.css"    src/styles/tokens/spacing.css
  cp "docs/Cerebro Design System/tokens/fonts.css"      src/styles/tokens/fonts.css
  cp "docs/Cerebro Design System/tokens/base.css"       src/styles/tokens/base.css
  ```

  Expected: five files in `src/styles/tokens/`, byte-identical to the DS sources.

- [ ] **Step 2: Copy the font binaries**

  Run:

  ```sh
  cp "docs/Cerebro Design System/assets/fonts/InstrumentSans-Variable.ttf"        src/assets/fonts/
  cp "docs/Cerebro Design System/assets/fonts/InstrumentSans-Italic-Variable.ttf" src/assets/fonts/
  cp "docs/Cerebro Design System/assets/fonts/IBMPlexMono-Regular.ttf"            src/assets/fonts/
  cp "docs/Cerebro Design System/assets/fonts/IBMPlexMono-Medium.ttf"             src/assets/fonts/
  cp "docs/Cerebro Design System/assets/fonts/IBMPlexMono-SemiBold.ttf"           src/assets/fonts/
  ```

  Expected: five `.ttf` files in `src/assets/fonts/`.

- [ ] **Step 3: Rewrite `src/styles/tokens/fonts.css` with corrected `url()` paths**

  The DS file references `../assets/fonts/…`; from `src/styles/tokens/` the fonts now live at `../../assets/fonts/…`. Replace the file's full contents with:

  ```css
  @font-face{font-family:'Instrument Sans';src:url('../../assets/fonts/InstrumentSans-Variable.ttf') format('truetype-variations');font-weight:400 700;font-stretch:75% 100%;font-style:normal;font-display:swap}
  @font-face{font-family:'Instrument Sans';src:url('../../assets/fonts/InstrumentSans-Italic-Variable.ttf') format('truetype-variations');font-weight:400 700;font-stretch:75% 100%;font-style:italic;font-display:swap}
  @font-face{font-family:'IBM Plex Mono';src:url('../../assets/fonts/IBMPlexMono-Regular.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap}
  @font-face{font-family:'IBM Plex Mono';src:url('../../assets/fonts/IBMPlexMono-Medium.ttf') format('truetype');font-weight:500;font-style:normal;font-display:swap}
  @font-face{font-family:'IBM Plex Mono';src:url('../../assets/fonts/IBMPlexMono-SemiBold.ttf') format('truetype');font-weight:600;font-style:normal;font-display:swap}
  ```

- [ ] **Step 4: Rewrite `src/styles/index.css` — imports + `@theme inline` bridge**

  `@theme inline` is used because every bridged value references an existing token variable; `inline` makes Tailwind emit the `var(--…)` reference directly into utilities instead of a second layer of variables. The two font stacks are literal duplicates of `typography.css` values (bridging `--font-mono: var(--font-mono)` would be self-referential). Full file contents:

  ```css
  @import 'tailwindcss';

  @import './tokens/fonts.css';
  @import './tokens/colors.css';
  @import './tokens/typography.css';
  @import './tokens/spacing.css';
  @import './tokens/base.css';

  @theme inline {
    /* fonts — literal mirrors of --font-ui / --font-mono in tokens/typography.css */
    --font-sans: 'Instrument Sans', -apple-system, 'Segoe UI', sans-serif;
    --font-mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', monospace;

    /* neutrals — cool graphite */
    --color-n-0: var(--n-0);
    --color-n-25: var(--n-25);
    --color-n-50: var(--n-50);
    --color-n-100: var(--n-100);
    --color-n-200: var(--n-200);
    --color-n-300: var(--n-300);
    --color-n-400: var(--n-400);
    --color-n-500: var(--n-500);
    --color-n-600: var(--n-600);
    --color-n-700: var(--n-700);
    --color-n-800: var(--n-800);
    --color-n-900: var(--n-900);

    /* primary — cortex ultramarine */
    --color-cortex-50: var(--cortex-50);
    --color-cortex-100: var(--cortex-100);
    --color-cortex-200: var(--cortex-200);
    --color-cortex-300: var(--cortex-300);
    --color-cortex-400: var(--cortex-400);
    --color-cortex-500: var(--cortex-500);
    --color-cortex-600: var(--cortex-600);
    --color-cortex-700: var(--cortex-700);
    --color-cortex-800: var(--cortex-800);
    --color-cortex-900: var(--cortex-900);

    /* AI — synapse violet (AI surfaces only) */
    --color-synapse-50: var(--synapse-50);
    --color-synapse-100: var(--synapse-100);
    --color-synapse-200: var(--synapse-200);
    --color-synapse-300: var(--synapse-300);
    --color-synapse-400: var(--synapse-400);
    --color-synapse-500: var(--synapse-500);
    --color-synapse-600: var(--synapse-600);
    --color-synapse-700: var(--synapse-700);

    /* semantic */
    --color-success-50: var(--success-50);
    --color-success-500: var(--success-500);
    --color-success-600: var(--success-600);
    --color-success-700: var(--success-700);
    --color-warn-50: var(--warn-50);
    --color-warn-500: var(--warn-500);
    --color-warn-600: var(--warn-600);
    --color-warn-700: var(--warn-700);
    --color-danger-50: var(--danger-50);
    --color-danger-500: var(--danger-500);
    --color-danger-600: var(--danger-600);
    --color-danger-700: var(--danger-700);

    /* surfaces */
    --color-surface-app: var(--surface-app);
    --color-surface-board: var(--surface-board);
    --color-surface-sunken: var(--surface-sunken);
    --color-surface-raised: var(--surface-raised);
    --color-surface-selected: var(--surface-selected);
    --color-surface-ai: var(--surface-ai);

    /* accent */
    --color-accent: var(--accent);
    --color-accent-hover: var(--accent-hover);
    --color-accent-press: var(--accent-press);

    /* user-assignable swatches */
    --color-swatch-amber: var(--swatch-amber);
    --color-swatch-blue: var(--swatch-blue);
    --color-swatch-teal: var(--swatch-teal);
    --color-swatch-green: var(--swatch-green);
    --color-swatch-violet: var(--swatch-violet);
    --color-swatch-magenta: var(--swatch-magenta);
    --color-swatch-vermilion: var(--swatch-vermilion);
    --color-swatch-sky: var(--swatch-sky);

    /* radii */
    --radius-xs: var(--r-xs);
    --radius-sm: var(--r-sm);
    --radius-md: var(--r-md);
    --radius-lg: var(--r-lg);
    --radius-xl: var(--r-xl);
    --radius-full: var(--r-full);
  }
  ```

  Result: `bg-surface-sunken`, `text-cortex-600`, `border-n-200`, `rounded-xl` (14px), `font-mono`, etc. all resolve to DS tokens. Anything not bridged (shadows, layout constants, text scale) is used via arbitrary values, e.g. `shadow-[var(--shadow-sm)]`, `h-[var(--control-h)]`.

- [ ] **Step 5: Rewrite `src/App.tsx` as a styled verification card**

  The heading text stays exactly "Cerebro" so `src/App.test.tsx` keeps passing. Full file contents:

  ```tsx
  export default function App() {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-sunken">
        <div className="rounded-xl border border-n-200 bg-surface-raised px-8 py-6 shadow-[var(--shadow-sm)]">
          <h1 className="font-sans text-2xl font-semibold tracking-[var(--track-tight)] text-n-900">
            Cerebro
          </h1>
          <p className="mt-1 text-[length:var(--text-sm)] text-[color:var(--text-secondary)]">
            Files-first work management
          </p>
          <code className="mt-3 inline-block font-mono text-xs text-cortex-600">
            vault: not opened
          </code>
        </div>
      </main>
    );
  }
  ```

- [ ] **Step 6: Run the sanity test to verify it still passes**

  Run: `pnpm vitest run src/App.test.tsx`
  Expected: PASS (heading still named "Cerebro").

- [ ] **Step 7: Visual verification**

  Run: `pnpm dev` (open http://localhost:5173, Ctrl-C when done)
  Expected: `--n-50` sunken gray page; white card with 14px radius, `--n-200` border, and soft shadow; "Cerebro" set in Instrument Sans (network tab shows `InstrumentSans-Variable.ttf` loading); "vault: not opened" in IBM Plex Mono colored cortex blue `#2E48C2`.

- [ ] **Step 8: Commit**

  ```sh
  git add src/styles src/assets/fonts src/App.tsx
  git commit -m "feat: add Cerebro DS tokens, fonts, and Tailwind @theme bridge"
  ```

---

### Task 3: Port DS primitives to typed components in `src/components/ui/`

**Files:**
- Create: `src/components/ui/Icon.tsx`, `Button.tsx`, `IconButton.tsx`, `Input.tsx`, `Select.tsx`, `SegmentedControl.tsx`, `Avatar.tsx`, `Badge.tsx`, `Tag.tsx`, `StatusFlag.tsx`, `ProgressBar.tsx`, `FilterChip.tsx`, `Tooltip.tsx`, `Toast.tsx`, `EmptyState.tsx`, `KanbanCard.tsx`, `Dialog.tsx`
- Test: `src/components/ui/Button.test.tsx`, `src/components/ui/Dialog.test.tsx`

Sources live in `docs/Cerebro Design System/components/` (each component: `<Name>.jsx` + `<Name>.d.ts`). Ports are 1:1 — same class names, same injected-`<style>` pattern, same token variables, same markup — with two deliberate adaptations: **Icon** swaps the lucide CDN loader for the bundled `lucide-react` package, and **KanbanCard** inlines the "feature" glyph because `EntityIcon` is not in the M1 port set.

- [ ] **Step 1: Write the failing Button test**

  `src/components/ui/Button.test.tsx`:

  ```tsx
  import { render, screen, fireEvent } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';
  import { Button } from '@/components/ui/Button';

  describe('Button', () => {
    it('renders children with secondary variant and md size by default', () => {
      render(<Button>Save view</Button>);
      const btn = screen.getByRole('button', { name: 'Save view' }) as HTMLButtonElement;
      expect(btn.className).toContain('cb-btn-secondary');
      expect(btn.className).toContain('cb-btn-md');
      expect(btn.type).toBe('button');
    });

    it('applies each variant class', () => {
      const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;
      for (const variant of variants) {
        const { unmount } = render(<Button variant={variant}>{variant}</Button>);
        const btn = screen.getByRole('button', { name: variant });
        expect(btn.className).toContain(`cb-btn-${variant}`);
        unmount();
      }
    });

    it('applies size classes', () => {
      const { unmount } = render(<Button size="sm">Small</Button>);
      expect(screen.getByRole('button', { name: 'Small' }).className).toContain('cb-btn-sm');
      unmount();
      render(<Button size="lg">Large</Button>);
      expect(screen.getByRole('button', { name: 'Large' }).className).toContain('cb-btn-lg');
    });

    it('fires onClick, but not when disabled', () => {
      const onClick = vi.fn();
      const { unmount } = render(<Button onClick={onClick}>Go</Button>);
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect(onClick).toHaveBeenCalledTimes(1);
      unmount();

      const onClickDisabled = vi.fn();
      render(
        <Button disabled onClick={onClickDisabled}>
          Stop
        </Button>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(onClickDisabled).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `pnpm vitest run src/components/ui/Button.test.tsx`
  Expected: FAIL — `Cannot find module '@/components/ui/Button'`.

- [ ] **Step 3: Port Icon (lucide-react adaptation — full code)**

  Source: `docs/Cerebro Design System/components/core/Icon.jsx` + `Icon.d.ts`. The DS source lazy-loads lucide from a CDN into `window.lucide`; the port replaces that entirely with the bundled `lucide-react` `icons` map (kebab-case names converted to PascalCase keys). Same defaults: size 16, stroke 1.75, `currentColor`. Unknown names render an empty 24×24 svg placeholder instead of crashing.

  `src/components/ui/Icon.tsx` (full contents):

  ```tsx
  import React from 'react';
  import { icons } from 'lucide-react';

  /** Lucide line icon (bundled via lucide-react), 1.75 stroke, currentColor. */
  export interface IconProps {
    /** lucide icon name, kebab-case, e.g. "target", "layout-grid" */
    name: string;
    /** px, default 16 */
    size?: number;
    /** default 1.75 */
    strokeWidth?: number;
    /** css color; defaults to currentColor */
    color?: string;
    style?: React.CSSProperties;
    className?: string;
  }

  const pascal = (n: string) =>
    n
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join('');

  export function Icon({ name, size = 16, strokeWidth = 1.75, color, style, className }: IconProps) {
    const baseStyle: React.CSSProperties = {
      flex: 'none',
      display: 'inline-block',
      verticalAlign: 'middle',
      color,
      ...style,
    };
    const Lucide = icons[pascal(name) as keyof typeof icons];
    if (!Lucide) {
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={baseStyle}
          aria-hidden="true"
        />
      );
    }
    return (
      <Lucide
        size={size}
        strokeWidth={strokeWidth}
        className={className}
        style={baseStyle}
        aria-hidden="true"
      />
    );
  }
  ```

- [ ] **Step 4: Port Button (fully worked reference port — full code)**

  Source: `docs/Cerebro Design System/components/core/Button.jsx` + `Button.d.ts`. The `css` string and markup are verbatim from the source; the only changes are the `@/components/ui/Icon` import, the props interface merged in from the `.d.ts`, and TS types on the function.

  `src/components/ui/Button.tsx` (full contents):

  ```tsx
  import React from 'react';
  import { Icon } from '@/components/ui/Icon';

  const css = `
  .cb-btn{font-family:var(--font-ui);font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:var(--r-md);border:1px solid transparent;cursor:pointer;white-space:nowrap;transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);outline:none}
  .cb-btn:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
  .cb-btn[disabled]{cursor:not-allowed;opacity:.45}
  .cb-btn-md{height:var(--control-h);padding:0 12px;font-size:var(--text-sm)}
  .cb-btn-sm{height:var(--control-h-sm);padding:0 10px;font-size:var(--text-xs)}
  .cb-btn-lg{height:var(--control-h-lg);padding:0 16px;font-size:var(--text-md)}
  .cb-btn-primary{background:var(--accent);color:#fff}
  .cb-btn-primary:hover:not([disabled]){background:var(--accent-hover)}
  .cb-btn-primary:active:not([disabled]){background:var(--accent-press)}
  .cb-btn-secondary{background:var(--n-0);color:var(--n-800);border-color:var(--n-300)}
  .cb-btn-secondary:hover:not([disabled]){background:var(--n-50)}
  .cb-btn-secondary:active:not([disabled]){background:var(--n-100)}
  .cb-btn-ghost{background:transparent;color:var(--n-600)}
  .cb-btn-ghost:hover:not([disabled]){background:var(--n-50);color:var(--n-800)}
  .cb-btn-ghost:active:not([disabled]){background:var(--n-100)}
  .cb-btn-danger{background:var(--danger-500);color:#fff}
  .cb-btn-danger:hover:not([disabled]){background:var(--danger-600)}
  .cb-btn-danger:active:not([disabled]){background:var(--danger-700)}`;
  if (typeof document !== 'undefined' && !document.getElementById('cb-btn-css')) {
    const t = document.createElement('style');
    t.id = 'cb-btn-css';
    t.textContent = css;
    document.head.appendChild(t);
  }

  /** Action button. */
  export interface ButtonProps {
    /** "primary" | "secondary" (default) | "ghost" | "danger" */
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    /** "sm" 28px | "md" 32px (default) | "lg" 38px */
    size?: 'sm' | 'md' | 'lg';
    /** optional leading lucide icon name */
    icon?: string;
    children?: React.ReactNode;
    fullWidth?: boolean;
    disabled?: boolean;
    onClick?: () => void;
    type?: 'button' | 'submit';
    style?: React.CSSProperties;
    className?: string;
  }

  export function Button({
    variant = 'secondary',
    size = 'md',
    icon,
    children,
    fullWidth,
    disabled,
    onClick,
    type = 'button',
    style,
    className = '',
  }: ButtonProps) {
    const iconSize = size === 'sm' ? 14 : 16;
    return (
      <button
        type={type}
        disabled={disabled}
        onClick={onClick}
        className={`cb-btn cb-btn-${size} cb-btn-${variant} ${className}`}
        style={{ width: fullWidth ? '100%' : undefined, ...style }}
      >
        {icon ? <Icon name={icon} size={iconSize} /> : null}
        {children}
      </button>
    );
  }
  ```

- [ ] **Step 5: Run test to verify it passes**

  Run: `pnpm vitest run src/components/ui/Button.test.tsx`
  Expected: PASS (4 tests).

- [ ] **Step 6: Apply the conversion procedure to the remaining components**

  The Button port above is the template. For each component in Steps 7–19, apply exactly this procedure to its named source files:

  1. Read `<Name>.jsx` and `<Name>.d.ts` at the quoted source path.
  2. Create `src/components/ui/<Name>.tsx`.
  3. Copy the `css` template string and its injection guard **verbatim** (same style-tag `id`, same class names, same token variables — the DS visuals must stay byte-identical).
  4. Move the interface(s) from the `.d.ts` into the `.tsx` as `export interface …` (drop the `export declare function` line); type the component as `export function <Name>(props: <Name>Props)` keeping the exact destructured defaults from the `.jsx`.
  5. Rewrite relative DS imports to alias imports: `./Icon.jsx` and `../core/Icon.jsx` → `@/components/ui/Icon`; `../core/IconButton.jsx` → `@/components/ui/IconButton`; `../core/Button.jsx` → `@/components/ui/Button`; `../display/Avatar.jsx` → `@/components/ui/Avatar`; `../display/Tag.jsx` → `@/components/ui/Tag`.
  6. Tighten `.d.ts` `any` types: Input `onChange` → `React.ChangeEventHandler<HTMLInputElement>`, `onKeyDown` → `React.KeyboardEventHandler<HTMLInputElement>`; Select `onChange` → `React.ChangeEventHandler<HTMLSelectElement>`. Inline handler params get their precise `React.MouseEvent` type.
  7. Type internal lookup maps that are indexed with an arbitrary string as `Record<string, …>` (Badge `TONES`, Toast `CFG`, StatusFlag `STATUSES`) so `MAP[key] || MAP.fallback` compiles under `strict`.
  8. Where a style object sets a custom property (KanbanCard's `--kc`), cast: `style={{ '--kc': swatch, ...style } as React.CSSProperties}`.
  9. After each file, run `pnpm exec tsc --noEmit` and confirm it is clean before moving on.

- [ ] **Step 7: Port IconButton**

  Source: `docs/Cerebro Design System/components/core/IconButton.jsx` → Target: `src/components/ui/IconButton.tsx`. Imports `Icon`. Props from `IconButton.d.ts`:

  ```ts
  export interface IconButtonProps {
    /** lucide icon name */ icon: string;
    /** tooltip + aria-label (required) */ label: string;
    /** "sm" 24 | "md" 28 (default) | "lg" 32 */ size?: 'sm' | 'md' | 'lg';
    /** "ghost" (default) | "outline" */ variant?: 'ghost' | 'outline';
    /** toggled-on state (cortex tint) */ active?: boolean;
    disabled?: boolean;
    onClick?: () => void;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 8: Port Input**

  Source: `docs/Cerebro Design System/components/core/Input.jsx` → Target: `src/components/ui/Input.tsx`. Imports `Icon`. Props from `Input.d.ts` (with the event types from procedure rule 6):

  ```ts
  export interface InputProps {
    /** leading lucide icon, e.g. "search" */ icon?: string;
    placeholder?: string;
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;   // .d.ts: (e: any) => void
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>; // .d.ts: (e: any) => void
    /** right-side node, e.g. <kbd>⌘K</kbd> */ suffix?: React.ReactNode;
    /** "sm" 28 | "md" 32 (default) | "lg" 38 */ size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    autoFocus?: boolean;
    /** css width, e.g. 280 or "100%" */ width?: number | string;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 9: Port Select**

  Source: `docs/Cerebro Design System/components/core/Select.jsx` → Target: `src/components/ui/Select.tsx`. Imports `Icon` (chevron). Props from `Select.d.ts`:

  ```ts
  export interface SelectOption { value: string; label: string }
  export interface SelectProps {
    options: SelectOption[];
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLSelectElement>; // .d.ts: (e: any) => void
    /** "sm" 28 | "md" 32 (default) */ size?: 'sm' | 'md';
    disabled?: boolean;
    width?: number | string;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 10: Port SegmentedControl**

  Source: `docs/Cerebro Design System/components/core/SegmentedControl.jsx` → Target: `src/components/ui/SegmentedControl.tsx`. Imports `Icon`. Props from `SegmentedControl.d.ts`:

  ```ts
  export interface SegmentOption { value: string; label: string; icon?: string }
  export interface SegmentedControlProps {
    options: SegmentOption[];
    value?: string;
    onChange?: (value: string) => void;
    /** "sm" 28 total (default) | "md" 32 total */ size?: 'sm' | 'md';
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 11: Port Avatar (+ AvatarGroup, same file)**

  Source: `docs/Cerebro Design System/components/display/Avatar.jsx` → Target: `src/components/ui/Avatar.tsx`. No DS imports; keep the `PALETTE`, `hash`, and `initials` helpers verbatim (type them: `hash = (s: string): number`, `initials = (n: string): string`). Props from `Avatar.d.ts`:

  ```ts
  export interface AvatarProps {
    /** full name; initials derived */ name: string;
    /** px, default 24 (use 20 in table rows, 28 in headers) */ size?: number;
    /** optional image url */ src?: string;
    style?: React.CSSProperties;
    className?: string;
  }
  export interface AvatarGroupProps {
    names: string[];
    size?: number;
    /** max shown before +N, default 3 */ max?: number;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

  Note: the source defaults `name = "?"`; keep that default even though the prop is typed required.

- [ ] **Step 12: Port Badge**

  Source: `docs/Cerebro Design System/components/display/Badge.jsx` → Target: `src/components/ui/Badge.tsx`. No DS imports. Type the tones map `const TONES: Record<string, { bg: string; fg: string }>` (procedure rule 7). Props from `Badge.d.ts`:

  ```ts
  export interface BadgeProps {
    /** "neutral" (default) | "info" | "success" | "warn" | "danger" | "ai" */
    tone?: 'neutral' | 'info' | 'success' | 'warn' | 'danger' | 'ai';
    /** "tint" (default) | "outline" */ variant?: 'tint' | 'outline';
    children?: React.ReactNode;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 13: Port Tag**

  Source: `docs/Cerebro Design System/components/display/Tag.jsx` → Target: `src/components/ui/Tag.tsx`. Imports `Icon` (leading icon + remove ×). Props from `Tag.d.ts`:

  ```ts
  export interface TagProps {
    children?: React.ReactNode;
    /** leading swatch dot color, e.g. "var(--swatch-teal)" */ color?: string;
    /** or a leading lucide icon */ icon?: string;
    onRemove?: () => void;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 14: Port StatusFlag**

  Source: `docs/Cerebro Design System/components/display/StatusFlag.jsx` → Target: `src/components/ui/StatusFlag.tsx`. No DS imports (inline flag `<svg>` kept verbatim). Type the map `const STATUSES: Record<string, { label: string; color: string }>`. Props from `StatusFlag.d.ts`:

  ```ts
  export interface StatusFlagProps {
    /** "idea" | "planned" | "progress" | "validation" | "released" | "wontdo" */
    status?: 'idea' | 'planned' | 'progress' | 'validation' | 'released' | 'wontdo';
    /** custom label (for space-specific statuses) */ label?: string;
    /** custom flag color */ color?: string;
    /** glyph only, no chip chrome */ bare?: boolean;
    size?: 'sm' | 'md';
    style?: React.CSSProperties;
    className?: string;
  }
  ```

  (Space-specific statuses from the schema engine render via `label` + `color`; the built-in `status` presets stay for DS parity.)

- [ ] **Step 15: Port ProgressBar**

  Source: `docs/Cerebro Design System/components/display/ProgressBar.jsx` → Target: `src/components/ui/ProgressBar.tsx`. No DS imports. Props from `ProgressBar.d.ts`:

  ```ts
  export interface ProgressBarProps {
    /** 0–100 */ value: number;
    /** track width px, default 120 */ width?: number;
    /** "default" cortex | "success" | "warn" | "danger" */
    tone?: 'default' | 'success' | 'warn' | 'danger';
    showLabel?: boolean;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 16: Port FilterChip**

  Source: `docs/Cerebro Design System/components/navigation/FilterChip.jsx` → Target: `src/components/ui/FilterChip.tsx`. Imports `Icon`. The remove-`×` span handler types as `(e: React.MouseEvent) => { e.stopPropagation(); onRemove(); }`. Props from `FilterChip.d.ts`:

  ```ts
  export interface FilterChipProps {
    label: string;
    /** bolded value after a colon */ value?: string;
    icon?: string;
    /** selected state (cortex tint) */ active?: boolean;
    /** green "modified" dot */ dot?: boolean;
    onClick?: () => void;
    onRemove?: () => void;
    style?: React.CSSProperties;
    className?: string;
  }
  ```

- [ ] **Step 17: Port Tooltip, Toast, EmptyState**

  - Tooltip — Source: `docs/Cerebro Design System/components/feedback/Tooltip.jsx` → Target: `src/components/ui/Tooltip.tsx`. No DS imports.

    ```ts
    export interface TooltipProps {
      content: React.ReactNode;
      /** keyboard hint, e.g. "⌘K" */ kbd?: string;
      /** "top" (default) | "bottom" */ side?: 'top' | 'bottom';
      children?: React.ReactNode;
      style?: React.CSSProperties;
      className?: string;
    }
    ```

  - Toast — Source: `docs/Cerebro Design System/components/feedback/Toast.jsx` → Target: `src/components/ui/Toast.tsx`. Imports `Icon`, `IconButton`. Type `const CFG: Record<string, { icon: string; color: string }>`.

    ```ts
    export interface ToastProps {
      /** "neutral" (default) | "success" | "warn" | "danger" | "ai" */
      tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'ai';
      title: string;
      description?: string;
      action?: { label: string; onClick?: () => void };
      onDismiss?: () => void;
      style?: React.CSSProperties;
      className?: string;
    }
    ```

  - EmptyState — Source: `docs/Cerebro Design System/components/feedback/EmptyState.jsx` → Target: `src/components/ui/EmptyState.tsx`. Imports `Icon`.

    ```ts
    export interface EmptyStateProps {
      /** lucide icon, default "inbox" */ icon?: string;
      title: string;
      description?: string;
      /** action node, typically a <Button> */ action?: React.ReactNode;
      /** tighter paddings for panels */ compact?: boolean;
      style?: React.CSSProperties;
      className?: string;
    }
    ```

- [ ] **Step 18: Port KanbanCard (EntityIcon adaptation — full code)**

  Source: `docs/Cerebro Design System/components/boards/KanbanCard.jsx` + `KanbanCard.d.ts`. The source imports `EntityIcon`, which is **not** in the M1 port set; since every M1 board card is a work item, the "feature" rounded-square glyph from `EntityIcon.jsx` is inlined as a private helper and used for all cards (the `entity` prop is kept for API parity but no longer selects a glyph — documented deviation).

  `src/components/ui/KanbanCard.tsx` (full contents):

  ```tsx
  import React from 'react';
  import { Avatar } from '@/components/ui/Avatar';
  import { Tag } from '@/components/ui/Tag';
  import { Icon } from '@/components/ui/Icon';

  const css = `
  .cb-kcard{position:relative;background:var(--n-0);border:1px solid var(--n-200);border-radius:var(--r-lg);box-shadow:var(--shadow-xs);padding:10px 12px 10px 15px;cursor:pointer;transition:box-shadow var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);overflow:hidden}
  .cb-kcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--kc,var(--ent-feature))}
  .cb-kcard:hover{box-shadow:var(--shadow-md);border-color:var(--n-300)}
  .cb-kcard-title{display:flex;align-items:flex-start;gap:7px;font-size:var(--text-sm);font-weight:500;color:var(--n-900);line-height:18px}
  .cb-kcard-meta{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:var(--text-xs);color:var(--text-muted)}
  .cb-kcard-tags{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}`;
  if (typeof document !== 'undefined' && !document.getElementById('cb-kcard-css')) {
    const t = document.createElement('style');
    t.id = 'cb-kcard-css';
    t.textContent = css;
    document.head.appendChild(t);
  }

  export interface KanbanCardTag { label: string; icon?: string; color?: string }

  /** Kanban column card: 3px swatch edge, entity glyph, timeframe, owner. */
  export interface KanbanCardProps {
    title: string;
    /** entity type, default "feature" (M1: kept for API parity, glyph is always the feature square) */
    entity?: string;
    /** left-edge + glyph color, default feature cyan */
    swatch?: string;
    /** e.g. "Aug 2026 → Oct 2026" */
    timeframe?: string;
    /** owner full name (renders Avatar) */
    owner?: string;
    /** linked entity chips */
    tags?: KanbanCardTag[];
    onClick?: () => void;
    style?: React.CSSProperties;
    className?: string;
  }

  /** M1 adaptation: EntityIcon is not ported; this is its "feature" branch, inlined. */
  function EntityGlyph({ swatch, size = 16, style }: { swatch: string; size?: number; style?: React.CSSProperties }) {
    const s = Math.round(size * 0.7);
    return (
      <span
        style={{
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
          verticalAlign: 'middle',
          ...style,
        }}
      >
        <span style={{ width: s, height: s, borderRadius: Math.max(2, s * 0.28), background: swatch }} />
      </span>
    );
  }

  export function KanbanCard({
    title,
    swatch = 'var(--ent-feature)',
    timeframe,
    owner,
    tags = [],
    onClick,
    style,
    className = '',
  }: KanbanCardProps) {
    return (
      <div
        className={`cb-kcard ${className}`}
        onClick={onClick}
        style={{ '--kc': swatch, ...style } as React.CSSProperties}
      >
        <div className="cb-kcard-title">
          <EntityGlyph swatch={swatch} size={16} style={{ marginTop: 1 }} />
          {title}
        </div>
        {tags.length ? (
          <div className="cb-kcard-tags">
            {tags.map((t, i) => (
              <Tag key={i} icon={t.icon} color={t.color}>
                {t.label}
              </Tag>
            ))}
          </div>
        ) : null}
        <div className="cb-kcard-meta">
          {timeframe ? (
            <>
              <Icon name="calendar" size={12} />
              <span>{timeframe}</span>
            </>
          ) : null}
          {owner ? <Avatar name={owner} size={20} style={{ marginLeft: 'auto' }} /> : null}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 19: Type-check all ports so far**

  Run: `pnpm exec tsc --noEmit`
  Expected: no errors (Dialog does not exist yet and nothing imports it).

- [ ] **Step 20: Write the failing Dialog test**

  `src/components/ui/Dialog.test.tsx`:

  ```tsx
  import { render, screen, fireEvent } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';
  import { Dialog } from '@/components/ui/Dialog';

  describe('Dialog', () => {
    it('renders nothing when closed', () => {
      render(<Dialog open={false} title="Create item" />);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('renders title and children when open', () => {
      render(
        <Dialog open title="Create item">
          <p>Body content</p>
        </Dialog>,
      );
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText('Create item')).toBeTruthy();
      expect(screen.getByText('Body content')).toBeTruthy();
    });

    it('calls onClose from the close button', () => {
      const onClose = vi.fn();
      render(<Dialog open onClose={onClose} title="Create item" />);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on scrim mousedown but not on dialog mousedown', () => {
      const onClose = vi.fn();
      render(
        <Dialog open onClose={onClose} title="Create item">
          <p>Body content</p>
        </Dialog>,
      );
      fireEvent.mouseDown(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();
      const scrim = document.querySelector('.cb-dlg-scrim')!;
      fireEvent.mouseDown(scrim);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders footer actions and fires them', () => {
      const onPrimary = vi.fn();
      const onSecondary = vi.fn();
      render(
        <Dialog
          open
          title="Create item"
          primaryAction={{ label: 'Create', onClick: onPrimary }}
          secondaryAction={{ label: 'Cancel', onClick: onSecondary }}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onPrimary).toHaveBeenCalledTimes(1);
      expect(onSecondary).toHaveBeenCalledTimes(1);
    });
  });
  ```

- [ ] **Step 21: Run test to verify it fails**

  Run: `pnpm vitest run src/components/ui/Dialog.test.tsx`
  Expected: FAIL — `Cannot find module '@/components/ui/Dialog'`.

- [ ] **Step 22: Port Dialog (full code)**

  Source: `docs/Cerebro Design System/components/feedback/Dialog.jsx` + `Dialog.d.ts`. Imports `IconButton` and `Button` (both already ported).

  `src/components/ui/Dialog.tsx` (full contents):

  ```tsx
  import React from 'react';
  import { IconButton } from '@/components/ui/IconButton';
  import { Button } from '@/components/ui/Button';

  const css = `
  .cb-dlg-scrim{position:fixed;inset:0;background:var(--scrim);display:flex;align-items:flex-start;justify-content:center;padding:64px 24px;z-index:1000;animation:cbFade var(--dur-med) var(--ease-out)}
  .cb-dlg{background:var(--n-0);border-radius:var(--r-xl);box-shadow:var(--shadow-lg);width:100%;display:flex;flex-direction:column;max-height:calc(100vh - 128px);animation:cbUp var(--dur-med) var(--ease-out)}
  .cb-dlg-hd{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0 24px}
  .cb-dlg-hd h2{margin:0;font-size:var(--text-lg);line-height:var(--leading-lg);font-weight:600;letter-spacing:var(--track-tight);color:var(--n-900)}
  .cb-dlg-bd{padding:16px 24px;overflow:auto;font-size:var(--text-sm);color:var(--n-800)}
  .cb-dlg-ft{display:flex;align-items:center;gap:8px;padding:14px 24px;border-top:1px solid var(--n-100)}
  .cb-dlg-ft .cb-dlg-note{font-size:var(--text-xs);color:var(--text-muted);margin-right:auto}
  @keyframes cbFade{from{opacity:0}to{opacity:1}}
  @keyframes cbUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;
  if (typeof document !== 'undefined' && !document.getElementById('cb-dlg-css')) {
    const t = document.createElement('style');
    t.id = 'cb-dlg-css';
    t.textContent = css;
    document.head.appendChild(t);
  }

  export interface DialogAction { label: string; onClick?: () => void; disabled?: boolean }

  /** Modal dialog: flat scrim, radius-14 card, footer actions right-aligned. */
  export interface DialogProps {
    open: boolean;
    onClose?: () => void;
    title: string;
    children?: React.ReactNode;
    /** max width px, default 560 */
    width?: number;
    primaryAction?: DialogAction;
    secondaryAction?: DialogAction;
    /** muted left-aligned footer text */
    footerNote?: string;
    style?: React.CSSProperties;
  }

  export function Dialog({
    open,
    onClose,
    title,
    children,
    width = 560,
    primaryAction,
    secondaryAction,
    footerNote,
    style,
  }: DialogProps) {
    if (!open) return null;
    return (
      <div
        className="cb-dlg-scrim"
        onMouseDown={(e: React.MouseEvent) => {
          if (e.target === e.currentTarget && onClose) onClose();
        }}
      >
        <div className="cb-dlg" role="dialog" aria-modal="true" style={{ maxWidth: width, ...style }}>
          <div className="cb-dlg-hd">
            <h2>{title}</h2>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
          <div className="cb-dlg-bd">{children}</div>
          {primaryAction || secondaryAction || footerNote ? (
            <div className="cb-dlg-ft">
              {footerNote ? <span className="cb-dlg-note">{footerNote}</span> : <span className="cb-dlg-note"></span>}
              {secondaryAction ? <Button onClick={secondaryAction.onClick}>{secondaryAction.label}</Button> : null}
              {primaryAction ? (
                <Button variant="primary" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
                  {primaryAction.label}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 23: Run test to verify it passes**

  Run: `pnpm vitest run src/components/ui/Dialog.test.tsx`
  Expected: PASS (5 tests).

- [ ] **Step 24: Full suite + type-check**

  Run: `pnpm vitest run`
  Expected: PASS — App sanity, Button (4), Dialog (5).

  Run: `pnpm exec tsc --noEmit`
  Expected: no errors across all 17 ported components.

- [ ] **Step 25: Commit**

  ```sh
  git add src/components/ui
  git commit -m "feat: port Cerebro DS primitives to typed TSX components"
  ```

### Task 4: Rust frontmatter parser and Entry extraction (`parse.rs`, `entry.rs`)

**Files:**
- Modify: src-tauri/Cargo.toml
- Modify: src-tauri/src/lib.rs
- Create: src-tauri/src/vault/mod.rs
- Create: src-tauri/src/vault/parse.rs (tests inline in `#[cfg(test)] mod tests`)
- Create: src-tauri/src/vault/entry.rs (tests inline in `#[cfg(test)] mod tests`)

Depends on: Task 1 (Tauri scaffold exists at `src-tauri/`).

- [ ] **Step 1: Add the Rust crates the vault engine needs**

In `src-tauri/Cargo.toml`, under `[dependencies]`: replace the scaffold's `serde_json = "1"` line and append the new crates so the section contains all of the following lines (keep the scaffold's `tauri`, `serde`, and any `tauri-plugin-opener` lines unchanged):

```toml
serde_json = { version = "1", features = ["preserve_order"] }
serde_yaml = "0.9"
walkdir = "2"
notify = "6"
chrono = "0.4"
tauri-plugin-dialog = "2"
```

Note: `preserve_order` makes `serde_json::Map` keep insertion order, which Task 6 relies on to write frontmatter keys in the caller's order.

- [ ] **Step 2: Register the vault module**

Add this as the **first line** of `src-tauri/src/lib.rs` (leave the rest of the scaffold file unchanged for now — Task 7 rewrites it):

```rust
pub mod vault;
```

Create `src-tauri/src/vault/mod.rs`:

```rust
//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod parse;
```

- [ ] **Step 3: Write the failing parse tests**

Create `src-tauri/src/vault/parse.rs` with stubbed functions and the full test module:

```rust
//! Frontmatter splitting, YAML parsing, and markdown text helpers.

/// Split raw file content into (frontmatter block, body).
///
/// The block is the raw text between the opening `---` fence and the closing
/// fence line, including its trailing newline. The body is everything after
/// the closing fence line (one newline after the fence is consumed), so
/// `format!("---\n{block}---\n{body}")` reproduces the original bytes.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    todo!()
}

/// Parse a frontmatter block into a YAML mapping. Empty block → empty
/// mapping. Malformed YAML or non-mapping YAML → Err with the message.
pub fn parse_frontmatter(block: &str) -> Result<serde_yaml::Mapping, String> {
    todo!()
}

/// All wikilink targets in a string: `[[target]]` and `[[target|alias]]`.
pub fn wikilink_targets(text: &str) -> Vec<String> {
    todo!()
}

/// Wikilink targets in a note body, deduplicated preserving first-seen order.
pub fn extract_outgoing_links(body: &str) -> Vec<String> {
    todo!()
}

/// Text of the first H1 (`# ...`) line anywhere in the body.
pub fn extract_h1_title(body: &str) -> Option<String> {
    todo!()
}

/// Humanize a filename stem: `fix-login-flow` → `Fix Login Flow`.
pub fn humanize_stem(stem: &str) -> String {
    todo!()
}

/// First 160 chars of the body with markdown syntax roughly stripped.
pub fn extract_snippet(body: &str) -> String {
    todo!()
}

/// Convert a YAML value to a JSON value (tagged values unwrapped,
/// non-string mapping keys stringified).
pub fn yaml_to_json(value: &serde_yaml::Value) -> serde_json::Value {
    todo!()
}

/// Render a YAML mapping key as a plain string.
pub fn yaml_key_string(key: &serde_yaml::Value) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_frontmatter_and_body() {
        let content = "---\ntype: Work item\nstatus: todo\n---\n\n# Title\n\nBody.\n";
        let (block, body) = split_frontmatter(content);
        assert_eq!(block, Some("type: Work item\nstatus: todo\n"));
        assert_eq!(body, "\n# Title\n\nBody.\n");
    }

    #[test]
    fn content_without_frontmatter_is_all_body() {
        let content = "# Just a note\n\nNo frontmatter here.\n";
        let (block, body) = split_frontmatter(content);
        assert_eq!(block, None);
        assert_eq!(body, content);
    }

    #[test]
    fn unclosed_frontmatter_is_treated_as_body() {
        let content = "---\ntype: Work item\n\n# No closing fence\n";
        let (block, body) = split_frontmatter(content);
        assert_eq!(block, None);
        assert_eq!(body, content);
    }

    #[test]
    fn parses_valid_mapping() {
        let mapping = parse_frontmatter("type: Work item\nestimate: 3\n").unwrap();
        assert_eq!(mapping.get("type").and_then(|v| v.as_str()), Some("Work item"));
        assert_eq!(mapping.get("estimate").and_then(|v| v.as_i64()), Some(3));
    }

    #[test]
    fn malformed_yaml_returns_error() {
        assert!(parse_frontmatter("status: [unclosed\n").is_err());
    }

    #[test]
    fn non_mapping_frontmatter_returns_error() {
        assert!(parse_frontmatter("- just\n- a list\n").is_err());
    }

    #[test]
    fn extracts_wikilink_targets_including_piped_alias() {
        assert_eq!(wikilink_targets("[[atlas]]"), vec!["atlas"]);
        assert_eq!(wikilink_targets("[[maya-chen|Maya]]"), vec!["maya-chen"]);
        assert_eq!(wikilink_targets("see [[a]] and [[b|B]]"), vec!["a", "b"]);
        assert!(wikilink_targets("no links here").is_empty());
    }

    #[test]
    fn outgoing_links_dedupe_preserving_order() {
        let body = "Link [[b]] then [[a]] then [[b]] again.";
        assert_eq!(extract_outgoing_links(body), vec!["b", "a"]);
    }

    #[test]
    fn h1_title_is_first_h1_line_anywhere_in_body() {
        assert_eq!(extract_h1_title("\n# Ship it\n\nBody.\n"), Some("Ship it".to_string()));
        assert_eq!(extract_h1_title("intro\n\n# Later heading\n"), Some("Later heading".to_string()));
        assert_eq!(extract_h1_title("## Only h2\n\nBody.\n"), None);
    }

    #[test]
    fn humanizes_filename_stems() {
        assert_eq!(humanize_stem("fix-login-flow"), "Fix Login Flow");
        assert_eq!(humanize_stem("fld-7"), "Fld 7");
    }

    #[test]
    fn snippet_strips_markdown_and_truncates() {
        let body = "# Heading\n\nSome **bold** text with a [[target|nice link]].\n";
        assert_eq!(extract_snippet(body), "Some bold text with a nice link.");
        let long = format!("# H\n\n{}", "x".repeat(400));
        assert_eq!(extract_snippet(&long).chars().count(), 160);
    }

    #[test]
    fn converts_yaml_values_to_json() {
        let yaml: serde_yaml::Value =
            serde_yaml::from_str("kind: select\noptions:\n  - id: urgent\n    color: '#DE3B4E'\n")
                .unwrap();
        let json = yaml_to_json(&yaml);
        assert_eq!(json["kind"], "select");
        assert_eq!(json["options"][0]["id"], "urgent");
        assert_eq!(json["options"][0]["color"], "#DE3B4E");
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::parse`
Expected: FAIL — all 12 tests panic with `not yet implemented`.

- [ ] **Step 5: Implement parse.rs**

Replace the stub bodies. The non-test portion of `src-tauri/src/vault/parse.rs` becomes (keep the `#[cfg(test)] mod tests` block from Step 3 unchanged at the end of the file):

```rust
//! Frontmatter splitting, YAML parsing, and markdown text helpers.

/// Split raw file content into (frontmatter block, body).
///
/// The block is the raw text between the opening `---` fence and the closing
/// fence line, including its trailing newline. The body is everything after
/// the closing fence line (one newline after the fence is consumed), so
/// `format!("---\n{block}---\n{body}")` reproduces the original bytes.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    else {
        return (None, content);
    };
    if let Some(body) = rest.strip_prefix("---\n") {
        return (Some(""), body);
    }
    let mut search = 0;
    while let Some(pos) = rest[search..].find("\n---") {
        let idx = search + pos;
        let after = &rest[idx + 4..];
        if after.is_empty() || after.starts_with('\n') || after.starts_with("\r\n") {
            let block = &rest[..idx + 1];
            let body = after
                .strip_prefix("\r\n")
                .or_else(|| after.strip_prefix('\n'))
                .unwrap_or(after);
            return (Some(block), body);
        }
        search = idx + 1;
    }
    (None, content)
}

/// Parse a frontmatter block into a YAML mapping. Empty block → empty
/// mapping. Malformed YAML or non-mapping YAML → Err with the message.
pub fn parse_frontmatter(block: &str) -> Result<serde_yaml::Mapping, String> {
    if block.trim().is_empty() {
        return Ok(serde_yaml::Mapping::new());
    }
    let value: serde_yaml::Value = serde_yaml::from_str(block).map_err(|e| e.to_string())?;
    match value {
        serde_yaml::Value::Mapping(m) => Ok(m),
        serde_yaml::Value::Null => Ok(serde_yaml::Mapping::new()),
        _ => Err("frontmatter is not a mapping".to_string()),
    }
}

/// All wikilink targets in a string: `[[target]]` and `[[target|alias]]`.
pub fn wikilink_targets(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let inner_start = start + 2;
        let Some(end_rel) = rest[inner_start..].find("]]") else {
            break;
        };
        let inner = &rest[inner_start..inner_start + end_rel];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() && !target.contains('[') && !target.contains(']') {
            out.push(target.to_string());
        }
        rest = &rest[inner_start + end_rel + 2..];
    }
    out
}

/// Wikilink targets in a note body, deduplicated preserving first-seen order.
pub fn extract_outgoing_links(body: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    wikilink_targets(body)
        .into_iter()
        .filter(|t| seen.insert(t.clone()))
        .collect()
}

/// Text of the first H1 (`# ...`) line anywhere in the body.
pub fn extract_h1_title(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        line.trim()
            .strip_prefix("# ")
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
    })
}

/// Humanize a filename stem: `fix-login-flow` → `Fix Login Flow`.
pub fn humanize_stem(stem: &str) -> String {
    stem.split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// First 160 chars of the body with markdown syntax roughly stripped.
pub fn extract_snippet(body: &str) -> String {
    let text: String = body
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty() && !l.starts_with('#') && !l.starts_with("```") && !l.starts_with("---")
        })
        .map(strip_inline_markdown)
        .collect::<Vec<_>>()
        .join(" ");
    text.trim().chars().take(160).collect()
}

/// Strip list markers, emphasis chars, and unwrap wikilinks to display text.
fn strip_inline_markdown(line: &str) -> String {
    let line = line.trim_start_matches(['-', '*', '+', '>']).trim_start();
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let inner_start = start + 2;
        match rest[inner_start..].find("]]") {
            Some(end_rel) => {
                let inner = &rest[inner_start..inner_start + end_rel];
                let display = inner.split('|').next_back().unwrap_or(inner);
                out.push_str(display);
                rest = &rest[inner_start + end_rel + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.chars().filter(|c| !matches!(c, '*' | '_' | '`')).collect()
}

/// Convert a YAML value to a JSON value (tagged values unwrapped,
/// non-string mapping keys stringified).
pub fn yaml_to_json(value: &serde_yaml::Value) -> serde_json::Value {
    match value {
        serde_yaml::Value::Null => serde_json::Value::Null,
        serde_yaml::Value::Bool(b) => serde_json::Value::Bool(*b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::from(i)
            } else if let Some(u) = n.as_u64() {
                serde_json::Value::from(u)
            } else {
                n.as_f64().map(serde_json::Value::from).unwrap_or(serde_json::Value::Null)
            }
        }
        serde_yaml::Value::String(s) => serde_json::Value::String(s.clone()),
        serde_yaml::Value::Sequence(seq) => {
            serde_json::Value::Array(seq.iter().map(yaml_to_json).collect())
        }
        serde_yaml::Value::Mapping(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                obj.insert(yaml_key_string(k), yaml_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
        serde_yaml::Value::Tagged(t) => yaml_to_json(&t.value),
    }
}

/// Render a YAML mapping key as a plain string.
pub fn yaml_key_string(key: &serde_yaml::Value) -> String {
    match key {
        serde_yaml::Value::String(s) => s.clone(),
        other => serde_yaml::to_string(other)
            .map(|s| s.trim_end().to_string())
            .unwrap_or_default(),
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::parse`
Expected: PASS — 12 tests green.

- [ ] **Step 7: Write the failing Entry tests**

Update `src-tauri/src/vault/mod.rs` to:

```rust
//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod entry;
pub mod parse;
```

Create `src-tauri/src/vault/entry.rs` — the `Entry` struct is a shared contract (do not rename fields), `build_entry` is stubbed, tests are complete:

```rust
//! The `Entry` record produced for every markdown file in the vault.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::parse;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub filename: String,
    pub title: String,
    #[serde(rename = "type")]
    pub entry_type: Option<String>,
    pub properties: serde_json::Map<String, serde_json::Value>,
    pub relationships: BTreeMap<String, Vec<String>>,
    pub outgoing_links: Vec<String>,
    pub snippet: String,
    pub created_at: String,
    pub modified_at: String,
    pub parse_error: Option<String>,
}

/// Build an Entry from a vault-relative path (forward slashes) and raw file
/// content. Timestamps are passed in by the scanner (ISO 8601 strings).
pub fn build_entry(rel_path: &str, content: &str, created_at: String, modified_at: String) -> Entry {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATED: &str = "2026-07-24T10:00:00Z";
    const MODIFIED: &str = "2026-07-24T11:00:00Z";

    fn build(path: &str, content: &str) -> Entry {
        build_entry(path, content, CREATED.to_string(), MODIFIED.to_string())
    }

    #[test]
    fn extracts_full_entry_from_valid_note() {
        let content = "---\ntype: Work item\nkey: ATL-1\nstatus: in-progress\ntags:\n  - engine\n  - parser\nestimate: 3\nproject: \"[[atlas]]\"\n---\n\n# Fix the parser\n\nBody links [[atlas]] and [[maya-chen|Maya]].\n";
        let e = build("items/atl-1.md", content);
        assert_eq!(e.path, "items/atl-1.md");
        assert_eq!(e.filename, "atl-1.md");
        assert_eq!(e.title, "Fix the parser");
        assert_eq!(e.entry_type.as_deref(), Some("Work item"));
        assert_eq!(e.properties["key"], "ATL-1");
        assert_eq!(e.properties["status"], "in-progress");
        assert_eq!(e.properties["tags"], serde_json::json!(["engine", "parser"]));
        assert_eq!(e.properties["estimate"], 3);
        assert!(!e.properties.contains_key("project"));
        assert_eq!(e.relationships["project"], vec!["atlas"]);
        assert_eq!(e.outgoing_links, vec!["atlas", "maya-chen"]);
        assert!(e.snippet.starts_with("Body links atlas and Maya."));
        assert_eq!(e.created_at, CREATED);
        assert_eq!(e.modified_at, MODIFIED);
        assert!(e.parse_error.is_none());
    }

    #[test]
    fn wikilink_arrays_become_relationships() {
        let content = "---\nmembers:\n  - \"[[maya-chen]]\"\n  - \"[[joss-b|Joss]]\"\n---\n\n# Team\n";
        let e = build("spaces/team.md", content);
        assert_eq!(e.relationships["members"], vec!["maya-chen", "joss-b"]);
        assert!(!e.properties.contains_key("members"));
    }

    #[test]
    fn arrays_stay_arrays_even_with_one_item() {
        // Simplification vs Tolaria: no single-item → scalar normalization.
        let content = "---\ntags:\n  - solo\n---\n\n# One tag\n";
        let e = build("items/x.md", content);
        assert_eq!(e.properties["tags"], serde_json::json!(["solo"]));
    }

    #[test]
    fn nested_mappings_are_kept_in_properties() {
        // Type notes carry `fields:` mappings; space notes carry `statuses:`
        // arrays of mappings. Both must survive into properties as JSON so
        // the TS schema engine can read them.
        let content = "---\ntype: Type\nfields:\n  status: { kind: status }\n  due: { kind: date }\n---\n\n# Work item\n";
        let e = build("type/work-item.md", content);
        assert_eq!(e.properties["fields"]["status"]["kind"], "status");
        assert_eq!(e.properties["fields"]["due"]["kind"], "date");
    }

    #[test]
    fn malformed_yaml_sets_parse_error_with_empty_maps() {
        let content = "---\nstatus: [unclosed\n---\n\n# Broken\n";
        let e = build("items/broken.md", content);
        assert!(e.parse_error.is_some());
        assert!(e.properties.is_empty());
        assert!(e.relationships.is_empty());
        assert_eq!(e.entry_type, None);
        assert_eq!(e.title, "Broken");
    }

    #[test]
    fn missing_h1_falls_back_to_humanized_stem() {
        let content = "---\ntype: Work item\n---\n\nJust prose, no heading.\n";
        let e = build("items/fix-login-flow.md", content);
        assert_eq!(e.title, "Fix Login Flow");
    }

    #[test]
    fn serializes_to_camel_case_json() {
        let e = build("items/x.md", "# X\n");
        let json = serde_json::to_value(&e).unwrap();
        assert!(json.get("outgoingLinks").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("modifiedAt").is_some());
        assert!(json.get("parseError").is_some());
        assert!(json.get("type").is_some());
    }
}
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::entry`
Expected: FAIL — all 7 tests panic with `not yet implemented`.

- [ ] **Step 9: Implement build_entry**

Replace the `build_entry` stub in `src-tauri/src/vault/entry.rs` with the following (struct and tests stay unchanged):

```rust
/// Build an Entry from a vault-relative path (forward slashes) and raw file
/// content. Timestamps are passed in by the scanner (ISO 8601 strings).
pub fn build_entry(rel_path: &str, content: &str, created_at: String, modified_at: String) -> Entry {
    let filename = rel_path.rsplit('/').next().unwrap_or(rel_path).to_string();
    let stem = filename.strip_suffix(".md").unwrap_or(&filename).to_string();
    let (block, body) = parse::split_frontmatter(content);
    let (mapping, parse_error) = match block {
        Some(b) => match parse::parse_frontmatter(b) {
            Ok(m) => (m, None),
            Err(e) => (serde_yaml::Mapping::new(), Some(e)),
        },
        None => (serde_yaml::Mapping::new(), None),
    };

    let mut entry_type = None;
    let mut properties = serde_json::Map::new();
    let mut relationships = BTreeMap::new();
    for (key, value) in &mapping {
        let key = parse::yaml_key_string(key);
        if key == "type" {
            entry_type = value.as_str().map(str::to_string);
            continue;
        }
        let json = parse::yaml_to_json(value);
        match relationship_targets(&json) {
            Some(targets) => {
                relationships.insert(key, targets);
            }
            None => {
                properties.insert(key, json);
            }
        }
    }

    let title = parse::extract_h1_title(body).unwrap_or_else(|| parse::humanize_stem(&stem));

    Entry {
        path: rel_path.to_string(),
        filename,
        title,
        entry_type,
        properties,
        relationships,
        outgoing_links: parse::extract_outgoing_links(body),
        snippet: parse::extract_snippet(body),
        created_at,
        modified_at,
        parse_error,
    }
}

/// A frontmatter value is a relationship when its string content contains at
/// least one wikilink; returns the targets, or None for a plain value.
fn relationship_targets(value: &serde_json::Value) -> Option<Vec<String>> {
    let mut targets = Vec::new();
    collect_targets(value, &mut targets);
    if targets.is_empty() {
        None
    } else {
        Some(targets)
    }
}

fn collect_targets(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.extend(parse::wikilink_targets(s)),
        serde_json::Value::Array(items) => items.iter().for_each(|i| collect_targets(i, out)),
        _ => {}
    }
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::`
Expected: PASS — 19 tests green (12 parse + 7 entry).

- [ ] **Step 11: Commit**

```
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/vault/
git commit -m "feat: parse frontmatter into vault entries with wikilink relationships"
```

---

### Task 5: Rust vault scanner (`scan.rs`)

**Files:**
- Create: src-tauri/src/vault/testutil.rs (test-only helpers)
- Create: src-tauri/src/vault/scan.rs (tests inline in `#[cfg(test)] mod tests`)
- Modify: src-tauri/src/vault/mod.rs

Depends on: Task 4 (`parse.rs`, `entry.rs`).

- [ ] **Step 1: Create the test fixture helper**

No `tempfile` crate is in the dependency set — fixtures use `std::env::temp_dir()` with unique names. Create `src-tauri/src/vault/testutil.rs`:

```rust
//! Test-only helpers: build throwaway fixture vaults under the system temp dir.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Create a unique empty directory to use as a vault root. Callers remove it
/// with `std::fs::remove_dir_all` at the end of each test.
pub fn temp_vault(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("cerebro-test-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp vault");
    dir
}

/// Write a file at a vault-relative path, creating parent directories.
pub fn write(vault: &Path, rel: &str, content: &str) {
    let path = vault.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent dir");
    }
    std::fs::write(path, content).expect("write fixture file");
}
```

- [ ] **Step 2: Write the failing scanner tests**

Update `src-tauri/src/vault/mod.rs` to:

```rust
//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod entry;
pub mod parse;
pub mod scan;

#[cfg(test)]
pub mod testutil;
```

Create `src-tauri/src/vault/scan.rs` with a stub and complete tests:

```rust
//! Walk a vault folder and produce an Entry per markdown file.

use std::path::Path;

use super::entry::Entry;

/// Scan every `.md` file in the vault (skipping dot-directories, `views/`,
/// and `attachments/`) into Entries with vault-relative forward-slash paths,
/// sorted by path.
pub fn scan_vault(vault: &Path) -> Result<Vec<Entry>, String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use std::path::PathBuf;

    /// A small but representative vault: a type note, a space with statuses,
    /// a project, two items, one malformed item — plus files that must be
    /// skipped (views/, attachments/, dot-dir, non-md).
    fn fixture_vault(label: &str) -> PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "type/work-item.md", "---\ntype: Type\nicon: check-square\nfields:\n  status: { kind: status }\n  priority: { kind: select }\n---\n\n# Work item\n");
        testutil::write(&vault, "spaces/fielding.md", "---\ntype: Space\ncolor: '#3D8BE8'\nstatuses:\n  - { id: todo, group: active, color: '#3D8BE8' }\n  - { id: done, group: done, color: '#34B764' }\n---\n\n# Fielding\n");
        testutil::write(&vault, "projects/atlas.md", "---\ntype: Project\nkey: ATL\nspace: \"[[fielding]]\"\n---\n\n# Atlas\n");
        testutil::write(&vault, "items/atl-1.md", "---\ntype: Work item\nkey: ATL-1\nstatus: todo\nproject: \"[[atlas]]\"\n---\n\n# Ship the scanner\n");
        testutil::write(&vault, "items/atl-2.md", "---\ntype: Work item\nkey: ATL-2\nstatus: done\nproject: \"[[atlas]]\"\n---\n\n# Parse frontmatter\n");
        testutil::write(&vault, "items/broken.md", "---\nstatus: [unclosed\n---\n\n# Broken item\n");
        testutil::write(&vault, "views/all-items.yml", "name: All items\n");
        testutil::write(&vault, "attachments/readme.md", "# Not scanned\n");
        testutil::write(&vault, ".obsidian/workspace.md", "# Hidden\n");
        testutil::write(&vault, "notes.txt", "not markdown\n");
        vault
    }

    #[test]
    fn scans_only_markdown_files_sorted_by_relative_path() {
        let vault = fixture_vault("scan-paths");
        let entries = scan_vault(&vault).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "items/atl-1.md",
                "items/atl-2.md",
                "items/broken.md",
                "projects/atlas.md",
                "spaces/fielding.md",
                "type/work-item.md",
            ]
        );
        assert!(entries.iter().all(|e| !e.path.contains('\\')));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn skips_views_attachments_and_dot_dirs() {
        let vault = fixture_vault("scan-skips");
        let entries = scan_vault(&vault).unwrap();
        assert!(entries.iter().all(|e| {
            !e.path.starts_with("views/")
                && !e.path.starts_with("attachments/")
                && !e.path.starts_with(".obsidian/")
                && e.path.ends_with(".md")
        }));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn malformed_file_yields_parse_error_entry_and_scan_succeeds() {
        let vault = fixture_vault("scan-broken");
        let entries = scan_vault(&vault).unwrap();
        let broken = entries.iter().find(|e| e.path == "items/broken.md").unwrap();
        assert!(broken.parse_error.is_some());
        assert_eq!(broken.title, "Broken item");
        assert!(entries.iter().filter(|e| e.parse_error.is_some()).count() == 1);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn extracts_relationships_and_complex_properties() {
        let vault = fixture_vault("scan-props");
        let entries = scan_vault(&vault).unwrap();
        let project = entries.iter().find(|e| e.path == "projects/atlas.md").unwrap();
        assert_eq!(project.relationships["space"], vec!["fielding"]);
        let space = entries.iter().find(|e| e.path == "spaces/fielding.md").unwrap();
        assert_eq!(space.properties["statuses"].as_array().unwrap().len(), 2);
        let type_note = entries.iter().find(|e| e.path == "type/work-item.md").unwrap();
        assert_eq!(type_note.properties["fields"]["status"]["kind"], "status");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn timestamps_are_iso_8601() {
        let vault = fixture_vault("scan-times");
        let entries = scan_vault(&vault).unwrap();
        for e in &entries {
            assert!(chrono::DateTime::parse_from_rfc3339(&e.created_at).is_ok(), "{}", e.created_at);
            assert!(chrono::DateTime::parse_from_rfc3339(&e.modified_at).is_ok(), "{}", e.modified_at);
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn nonexistent_vault_errors() {
        assert!(scan_vault(Path::new("/definitely/not/a/real/vault")).is_err());
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::scan`
Expected: FAIL — all 6 tests panic with `not yet implemented`.

- [ ] **Step 4: Implement scan.rs**

Replace the stub. The non-test portion of `src-tauri/src/vault/scan.rs` becomes:

```rust
//! Walk a vault folder and produce an Entry per markdown file.

use std::path::Path;

use walkdir::WalkDir;

use super::entry::{build_entry, Entry};

const SKIPPED_DIRS: [&str; 2] = ["views", "attachments"];

fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

fn keep(item: &walkdir::DirEntry) -> bool {
    if !item.file_type().is_dir() {
        return true;
    }
    !is_skipped_dir(&item.file_name().to_string_lossy())
}

fn rel_path(vault: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(vault).map_err(|e| e.to_string())?;
    Ok(rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn iso_or_now(t: Option<std::time::SystemTime>) -> String {
    let t = t.unwrap_or_else(std::time::SystemTime::now);
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn timestamps(path: &Path) -> (String, String) {
    let meta = std::fs::metadata(path).ok();
    let modified = meta.as_ref().and_then(|m| m.modified().ok());
    let created = meta.as_ref().and_then(|m| m.created().ok()).or(modified);
    (iso_or_now(created), iso_or_now(modified))
}

/// Scan every `.md` file in the vault (skipping dot-directories, `views/`,
/// and `attachments/`) into Entries with vault-relative forward-slash paths,
/// sorted by path.
pub fn scan_vault(vault: &Path) -> Result<Vec<Entry>, String> {
    if !vault.is_dir() {
        return Err(format!("not a directory: {}", vault.display()));
    }
    let mut entries = Vec::new();
    let walker = WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || keep(e));
    for item in walker {
        let item = item.map_err(|e| e.to_string())?;
        if !item.file_type().is_file() {
            continue;
        }
        if item.path().extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel = rel_path(vault, item.path())?;
        let content = std::fs::read_to_string(item.path()).map_err(|e| format!("{rel}: {e}"))?;
        let (created, modified) = timestamps(item.path());
        entries.push(build_entry(&rel, &content, created, modified));
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::scan`
Expected: PASS — 6 tests green.

- [ ] **Step 6: Commit**

```
git add src-tauri/src/vault/
git commit -m "feat: scan vault folder into entries, skipping views, attachments and dot-dirs"
```

---

### Task 6: Rust vault writes (`write.rs`)

**Files:**
- Create: src-tauri/src/vault/write.rs (tests inline in `#[cfg(test)] mod tests`)
- Modify: src-tauri/src/vault/mod.rs

Depends on: Task 4 (`parse.rs`), Task 5 (`testutil.rs`).

- [ ] **Step 1: Write the failing update_frontmatter tests (with stubs for all write functions)**

Update `src-tauri/src/vault/mod.rs` to:

```rust
//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod entry;
pub mod parse;
pub mod scan;
pub mod write;

#[cfg(test)]
pub mod testutil;
```

Create `src-tauri/src/vault/write.rs`:

```rust
//! Disk writes: frontmatter patching, note bodies, note creation, views.
//! All writes go through `write_file` so the watcher (Task 8) can register
//! own-writes for suppression in one place.

use std::path::{Path, PathBuf};

use super::parse;

/// Raw saved-view file: `views/<id>.yml`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ViewYaml {
    pub id: String,
    pub yaml: String,
}

/// Apply a JSON patch to a note's frontmatter. `null` deletes a key; existing
/// keys keep their position; new keys append; unknown keys and the body are
/// untouched.
pub fn update_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    todo!()
}

/// Replace the note body, preserving the frontmatter block byte-for-byte.
pub fn save_note(vault: &Path, rel: &str, body: &str) -> Result<(), String> {
    todo!()
}

/// Return the note body only (frontmatter stripped).
pub fn read_note(vault: &Path, rel: &str) -> Result<String, String> {
    todo!()
}

/// Create `<folder>/<slug>.md` (deduping to `-2`, `-3`, …) with the given
/// frontmatter and body; empty body gets a humanized `# Title` line.
/// Returns the vault-relative path.
pub fn create_note(
    vault: &Path,
    folder: &str,
    slug: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<String, String> {
    todo!()
}

/// Replace the first H1 line of the body, or insert one as the first line.
pub fn set_note_title(vault: &Path, rel: &str, title: &str) -> Result<(), String> {
    todo!()
}

/// List `views/*.yml` as raw strings, sorted by id (filename stem).
pub fn list_views(vault: &Path) -> Result<Vec<ViewYaml>, String> {
    todo!()
}

/// Write `views/<id>.yml` verbatim, creating `views/` if needed.
pub fn save_view(vault: &Path, id: &str, yaml: &str) -> Result<(), String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    const NOTE: &str = "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n";

    fn vault_with_note(label: &str) -> std::path::PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "items/atl-1.md", NOTE);
        vault
    }

    fn read(vault: &Path, rel: &str) -> String {
        std::fs::read_to_string(vault.join(rel)).unwrap()
    }

    fn patch(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs.iter().cloned().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn update_preserves_order_and_unknown_keys_byte_for_byte() {
        let vault = vault_with_note("wfm-update");
        update_frontmatter(&vault, "items/atl-1.md", &patch(&[("status", serde_json::json!("done"))]))
            .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: done\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn null_patch_value_deletes_the_key_preserving_order() {
        let vault = vault_with_note("wfm-delete");
        update_frontmatter(&vault, "items/atl-1.md", &patch(&[("key", serde_json::Value::Null)]))
            .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn new_keys_are_appended_at_the_end() {
        let vault = vault_with_note("wfm-append");
        update_frontmatter(&vault, "items/atl-1.md", &patch(&[("due", serde_json::json!("2026-08-01"))]))
            .unwrap();
        let raw = read(&vault, "items/atl-1.md");
        assert!(raw.contains("custom_field: kept\ndue: 2026-08-01\n---\n"), "{raw}");
        let _ = std::fs::remove_dir_all(&vault);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::write`
Expected: FAIL — 3 tests panic with `not yet implemented`.

- [ ] **Step 3: Implement update_frontmatter and the shared write helpers**

In `src-tauri/src/vault/write.rs`, replace the `update_frontmatter` stub and add the helpers directly below the `ViewYaml` struct (other stubs stay for now):

```rust
/// Single funnel for all vault file writes. Task 8 hooks the watcher's
/// own-write suppression in here.
fn write_file(abs: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(abs, content).map_err(|e| e.to_string())
}

fn read_file(vault: &Path, rel: &str) -> Result<String, String> {
    std::fs::read_to_string(vault.join(rel)).map_err(|e| format!("{rel}: {e}"))
}

/// Recompose a file from a raw frontmatter block (with trailing newline) and
/// an untouched body. Empty/absent block → body only.
fn compose(block: Option<&str>, body: &str) -> String {
    match block {
        Some(b) if !b.trim().is_empty() => format!("---\n{b}---\n{body}"),
        _ => body.to_string(),
    }
}

fn serialize_mapping(mapping: &serde_yaml::Mapping) -> Result<Option<String>, String> {
    if mapping.is_empty() {
        return Ok(None);
    }
    serde_yaml::to_string(mapping).map(Some).map_err(|e| e.to_string())
}

/// Convert a JSON patch value to YAML for insertion into a mapping.
fn json_to_yaml(value: &serde_json::Value) -> serde_yaml::Value {
    match value {
        serde_json::Value::Null => serde_yaml::Value::Null,
        serde_json::Value::Bool(b) => serde_yaml::Value::Bool(*b),
        serde_json::Value::Number(n) => {
            serde_yaml::from_str(&n.to_string()).unwrap_or(serde_yaml::Value::Null)
        }
        serde_json::Value::String(s) => serde_yaml::Value::String(s.clone()),
        serde_json::Value::Array(items) => {
            serde_yaml::Value::Sequence(items.iter().map(json_to_yaml).collect())
        }
        serde_json::Value::Object(map) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, v) in map {
                m.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
            }
            serde_yaml::Value::Mapping(m)
        }
    }
}

/// Apply a JSON patch to a note's frontmatter. `null` deletes a key; existing
/// keys keep their position; new keys append; unknown keys and the body are
/// untouched.
pub fn update_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, body) = parse::split_frontmatter(&content);
    let mut mapping = match block {
        Some(b) => parse::parse_frontmatter(b)
            .map_err(|e| format!("{rel}: cannot patch malformed frontmatter: {e}"))?,
        None => serde_yaml::Mapping::new(),
    };
    for (key, value) in patch {
        let key = serde_yaml::Value::String(key.clone());
        if value.is_null() {
            mapping.shift_remove(&key); // shift_remove preserves key order
        } else {
            mapping.insert(key, json_to_yaml(value)); // existing keys keep position
        }
    }
    let new_block = serialize_mapping(&mapping)?;
    write_file(&vault.join(rel), &compose(new_block.as_deref(), body))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::write`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Write the failing tests for the remaining write operations**

Append these tests inside the existing `#[cfg(test)] mod tests` block of `src-tauri/src/vault/write.rs` (after `new_keys_are_appended_at_the_end`):

```rust
    #[test]
    fn save_note_replaces_body_and_keeps_frontmatter_bytes() {
        let vault = vault_with_note("wfm-save");
        save_note(&vault, "items/atl-1.md", "\n# Ship the scanner\n\nNew body.\n").unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nNew body.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn read_note_returns_body_only() {
        let vault = vault_with_note("wfm-read");
        assert_eq!(
            read_note(&vault, "items/atl-1.md").unwrap(),
            "\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_writes_frontmatter_and_dedupes_slug() {
        let vault = testutil::temp_vault("wfm-create");
        let fm = patch(&[
            ("type", serde_json::json!("Work item")),
            ("status", serde_json::json!("todo")),
        ]);
        let first = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        let second = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        let third = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        assert_eq!(first, "items/new-item.md");
        assert_eq!(second, "items/new-item-2.md");
        assert_eq!(third, "items/new-item-3.md");
        assert_eq!(
            read(&vault, "items/new-item.md"),
            "---\ntype: Work item\nstatus: todo\n---\n\n# New item\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_with_empty_body_gets_default_h1() {
        let vault = testutil::temp_vault("wfm-create-empty");
        create_note(&vault, "items", "empty-note", &patch(&[]), "").unwrap();
        assert_eq!(read(&vault, "items/empty-note.md"), "# Empty Note\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_replaces_existing_h1() {
        let vault = vault_with_note("wfm-title");
        set_note_title(&vault, "items/atl-1.md", "Renamed item").unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Renamed item\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_inserts_h1_when_missing() {
        let vault = testutil::temp_vault("wfm-title-insert");
        testutil::write(&vault, "items/no-title.md", "Just prose.\n");
        set_note_title(&vault, "items/no-title.md", "Now titled").unwrap();
        assert_eq!(read(&vault, "items/no-title.md"), "# Now titled\n\nJust prose.\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn views_round_trip_as_raw_yaml() {
        let vault = testutil::temp_vault("wfm-views");
        assert!(list_views(&vault).unwrap().is_empty());
        save_view(&vault, "all-items", "name: All items\npresentation:\n  type: list\n").unwrap();
        save_view(&vault, "board", "name: Board\n").unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "all-items");
        assert_eq!(views[0].yaml, "name: All items\npresentation:\n  type: list\n");
        assert_eq!(views[1].id, "board");
        let _ = std::fs::remove_dir_all(&vault);
    }
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::write`
Expected: FAIL — the 7 new tests panic with `not yet implemented`; the 3 update_frontmatter tests stay green.

- [ ] **Step 7: Implement the remaining write operations**

Replace the remaining stubs in `src-tauri/src/vault/write.rs`:

```rust
/// Replace the note body, preserving the frontmatter block byte-for-byte.
pub fn save_note(vault: &Path, rel: &str, body: &str) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, _) = parse::split_frontmatter(&content);
    write_file(&vault.join(rel), &compose(block, body))
}

/// Return the note body only (frontmatter stripped).
pub fn read_note(vault: &Path, rel: &str) -> Result<String, String> {
    let content = read_file(vault, rel)?;
    let (_, body) = parse::split_frontmatter(&content);
    Ok(body.to_string())
}

fn unique_rel_path(vault: &Path, folder: &str, slug: &str) -> String {
    let first = format!("{folder}/{slug}.md");
    if !vault.join(&first).exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{folder}/{slug}-{n}.md");
        if !vault.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Create `<folder>/<slug>.md` (deduping to `-2`, `-3`, …) with the given
/// frontmatter and body; empty body gets a humanized `# Title` line.
/// Returns the vault-relative path.
pub fn create_note(
    vault: &Path,
    folder: &str,
    slug: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<String, String> {
    let rel = unique_rel_path(vault, folder, slug);
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in frontmatter {
        if v.is_null() {
            continue;
        }
        mapping.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
    }
    let block = serialize_mapping(&mapping)?;
    let body = if body.trim().is_empty() {
        format!("# {}\n", parse::humanize_stem(slug))
    } else {
        body.to_string()
    };
    let content = match block {
        Some(b) => format!("---\n{b}---\n\n{body}"),
        None => body,
    };
    write_file(&vault.join(&rel), &content)?;
    Ok(rel)
}

fn replace_h1(body: &str, title: &str) -> String {
    let h1_line = format!("# {title}");
    let mut lines: Vec<&str> = body.lines().collect();
    match lines.iter().position(|l| l.trim_start().starts_with("# ")) {
        Some(idx) => {
            lines[idx] = &h1_line;
            let mut out = lines.join("\n");
            if body.ends_with('\n') {
                out.push('\n');
            }
            out
        }
        None => format!("{h1_line}\n\n{body}"),
    }
}

/// Replace the first H1 line of the body, or insert one as the first line.
pub fn set_note_title(vault: &Path, rel: &str, title: &str) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, body) = parse::split_frontmatter(&content);
    let new_body = replace_h1(body, title);
    write_file(&vault.join(rel), &compose(block, &new_body))
}

/// List `views/*.yml` as raw strings, sorted by id (filename stem).
pub fn list_views(vault: &Path) -> Result<Vec<ViewYaml>, String> {
    let dir = vault.join("views");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut views = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let yaml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        views.push(ViewYaml { id: id.to_string(), yaml });
    }
    views.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(views)
}

/// Write `views/<id>.yml` verbatim, creating `views/` if needed.
pub fn save_view(vault: &Path, id: &str, yaml: &str) -> Result<(), String> {
    write_file(&vault.join("views").join(format!("{id}.yml")), yaml)
}
```

Note: `PathBuf` in the `use` line becomes unused after this step — remove it (`use std::path::Path;`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::write`
Expected: PASS — 10 tests green.

- [ ] **Step 9: Commit**

```
git add src-tauri/src/vault/
git commit -m "feat: add vault write operations preserving frontmatter order and unknown keys"
```

---

### Task 7: App config, Tauri command wiring, and vault picker dialog

**Files:**
- Create: src-tauri/src/app_config.rs (tests inline in `#[cfg(test)] mod tests`)
- Modify: src-tauri/src/lib.rs (full rewrite)
- Modify: src-tauri/src/main.rs
- Modify: src-tauri/capabilities/default.json

Depends on: Tasks 4–6. `start_watcher` is the one IPC command NOT registered here — Task 8 adds it. No IPC integration harness exists in M1: commands are compile-checked here and exercised end-to-end by the Playwright smoke (Task 24).

- [ ] **Step 1: Write the failing app config tests**

Create `src-tauri/src/app_config.rs` with stubs and complete tests:

```rust
//! Persisted app configuration (last opened vault), stored as JSON in the
//! Tauri app-config directory.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub last_vault: Option<String>,
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join(CONFIG_FILE)
}

/// Load the config from `<dir>/config.json`; any failure → default config.
pub fn load(dir: &Path) -> AppConfig {
    todo!()
}

/// Write the config to `<dir>/config.json`, creating the directory.
pub fn save(dir: &Path, config: &AppConfig) -> Result<(), String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn load_returns_default_when_missing() {
        let dir = testutil::temp_vault("config-missing");
        assert_eq!(load(&dir), AppConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = testutil::temp_vault("config-roundtrip");
        let config = AppConfig { last_vault: Some("/Users/me/vault".to_string()) };
        save(&dir, &config).unwrap();
        assert_eq!(load(&dir), config);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_json_falls_back_to_default() {
        let dir = testutil::temp_vault("config-corrupt");
        std::fs::write(dir.join("config.json"), "{not json").unwrap();
        assert_eq!(load(&dir), AppConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_serializes_last_vault_as_camel_case() {
        let raw = serde_json::to_string(&AppConfig { last_vault: Some("/v".into()) }).unwrap();
        assert!(raw.contains("\"lastVault\""));
    }
}
```

Also add `pub mod app_config;` as the first line of `src-tauri/src/lib.rs` (above `pub mod vault;`) so the module compiles.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app_config`
Expected: FAIL — 4 tests panic with `not yet implemented`.

- [ ] **Step 3: Implement load and save**

Replace the two stubs in `src-tauri/src/app_config.rs`:

```rust
/// Load the config from `<dir>/config.json`; any failure → default config.
pub fn load(dir: &Path) -> AppConfig {
    std::fs::read_to_string(config_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Write the config to `<dir>/config.json`, creating the directory.
pub fn save(dir: &Path, config: &AppConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(dir), raw).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app_config`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Rewrite lib.rs with all IPC command wrappers**

Replace the entire contents of `src-tauri/src/lib.rs` with (this removes any scaffold `greet` command and `tauri_plugin_opener` registration — if the scaffold's Cargo.toml has a `tauri-plugin-opener` line, delete it too):

```rust
pub mod app_config;
pub mod vault;

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use vault::entry::Entry;
use vault::write::ViewYaml;

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn remember_vault(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let dir = config_dir(app)?;
    let mut config = app_config::load(&dir);
    config.last_vault = Some(path.to_string());
    app_config::save(&dir, &config)
}

#[tauri::command]
async fn pick_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().to_string();
    remember_vault(&app, &path)?;
    Ok(Some(path))
}

#[tauri::command]
fn get_last_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app_config::load(&config_dir(&app)?).last_vault)
}

#[tauri::command]
fn scan_vault(vault: String) -> Result<Vec<Entry>, String> {
    vault::scan::scan_vault(Path::new(&vault))
}

#[tauri::command]
fn read_note(vault: String, path: String) -> Result<String, String> {
    vault::write::read_note(Path::new(&vault), &path)
}

#[tauri::command]
fn save_note(vault: String, path: String, body: String) -> Result<(), String> {
    vault::write::save_note(Path::new(&vault), &path, &body)
}

#[tauri::command]
fn update_frontmatter(
    vault: String,
    path: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    vault::write::update_frontmatter(Path::new(&vault), &path, &patch)
}

#[tauri::command]
fn create_note(
    vault: String,
    folder: String,
    slug: String,
    frontmatter: serde_json::Map<String, serde_json::Value>,
    body: String,
) -> Result<String, String> {
    vault::write::create_note(Path::new(&vault), &folder, &slug, &frontmatter, &body)
}

#[tauri::command]
fn set_note_title(vault: String, path: String, title: String) -> Result<(), String> {
    vault::write::set_note_title(Path::new(&vault), &path, &title)
}

#[tauri::command]
fn list_views(vault: String) -> Result<Vec<ViewYaml>, String> {
    vault::write::list_views(Path::new(&vault))
}

#[tauri::command]
fn save_view(vault: String, id: String, yaml: String) -> Result<(), String> {
    vault::write::save_view(Path::new(&vault), &id, &yaml)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pick_vault,
            get_last_vault,
            scan_vault,
            read_note,
            save_note,
            update_frontmatter,
            create_note,
            set_note_title,
            list_views,
            save_view
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Replace the contents of `src-tauri/src/main.rs` with:

```rust
// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cerebro_lib::run();
}
```

The `[lib]` section of `src-tauri/Cargo.toml` must match — set it to:

```toml
[lib]
name = "cerebro_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

(If the Task 1 scaffold chose a different lib name, renaming it to `cerebro_lib` here keeps main.rs and all later tasks consistent.)

- [ ] **Step 6: Grant the dialog permission**

Replace the contents of `src-tauri/capabilities/default.json` with:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window capabilities",
  "windows": ["main"],
  "permissions": ["core:default", "dialog:default"]
}
```

- [ ] **Step 7: Verify the whole crate compiles and all tests pass**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — check clean; 39 tests green (12 parse + 7 entry + 6 scan + 10 write + 4 app_config).

- [ ] **Step 8: Commit**

```
git add src-tauri
git commit -m "feat: wire tauri commands, dialog vault picker and persisted app config"
```

---

### Task 8: Vault watcher with debounce and own-write suppression (`watcher.rs`)

**Files:**
- Create: src-tauri/src/vault/watcher.rs (tests inline in `#[cfg(test)] mod tests`)
- Modify: src-tauri/src/vault/mod.rs
- Modify: src-tauri/src/vault/write.rs
- Modify: src-tauri/src/lib.rs

Depends on: Tasks 6–7. Timing rules (shared contract): 350 ms debounce, 4 s own-write suppression, event name `vault-changed` with unit payload. The debounce/suppression decisions are pure functions and unit-tested; the threaded runtime is compile-checked (no integration harness in M1) and exercised by manual QA in `pnpm tauri dev`.

- [ ] **Step 1: Write the failing tests for the pure watcher logic**

Update `src-tauri/src/vault/mod.rs` to:

```rust
//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod entry;
pub mod parse;
pub mod scan;
pub mod watcher;
pub mod write;

#[cfg(test)]
pub mod testutil;
```

Create `src-tauri/src/vault/watcher.rs`:

```rust
//! Vault file watcher: notify-based, 350 ms debounce, own-write suppression.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const VAULT_CHANGED_EVENT: &str = "vault-changed";
pub const DEBOUNCE: Duration = Duration::from_millis(350);
pub const OWN_WRITE_WINDOW: Duration = Duration::from_secs(4);

/// Pure debounce decision: flush when there are pending changes and the vault
/// has been quiet for at least `quiet`.
pub fn should_flush(pending: bool, last_event: Option<Instant>, now: Instant, quiet: Duration) -> bool {
    todo!()
}

/// Pure suppression-window decision for a registered own-write.
pub fn own_write_active(registered: Instant, now: Instant, window: Duration) -> bool {
    todo!()
}

/// Vault-relative paths that should trigger a rescan: `.md` or `.yml` files
/// with no dot-prefixed component.
pub fn is_relevant_path(path: &Path) -> bool {
    todo!()
}

/// Record that this process just wrote `path` (called from write.rs).
pub fn note_own_write(path: &Path) {
    todo!()
}

/// True while `path` is inside the own-write suppression window.
pub fn is_suppressed(path: &Path) -> bool {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_pending_changes_never_flush() {
        let now = Instant::now();
        assert!(!should_flush(false, None, now, DEBOUNCE));
        assert!(!should_flush(false, Some(now), now + DEBOUNCE, DEBOUNCE));
        assert!(!should_flush(true, None, now, DEBOUNCE));
    }

    #[test]
    fn pending_changes_flush_only_after_quiet_period() {
        let t0 = Instant::now();
        assert!(!should_flush(true, Some(t0), t0 + Duration::from_millis(200), DEBOUNCE));
        assert!(should_flush(true, Some(t0), t0 + Duration::from_millis(350), DEBOUNCE));
        assert!(should_flush(true, Some(t0), t0 + Duration::from_millis(500), DEBOUNCE));
    }

    #[test]
    fn own_write_suppression_expires_after_window() {
        let t0 = Instant::now();
        assert!(own_write_active(t0, t0 + Duration::from_secs(3), OWN_WRITE_WINDOW));
        assert!(!own_write_active(t0, t0 + Duration::from_secs(4), OWN_WRITE_WINDOW));
    }

    #[test]
    fn registered_own_writes_are_suppressed() {
        let dir = crate::vault::testutil::temp_vault("watcher-own");
        let file = dir.join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(!is_suppressed(&file));
        note_own_write(&file);
        assert!(is_suppressed(&file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_md_and_yml_outside_dot_dirs_are_relevant() {
        assert!(is_relevant_path(Path::new("items/atl-1.md")));
        assert!(is_relevant_path(Path::new("views/all-items.yml")));
        assert!(!is_relevant_path(Path::new("attachments/logo.png")));
        assert!(!is_relevant_path(Path::new(".obsidian/workspace.md")));
        assert!(!is_relevant_path(Path::new("items/.hidden.md")));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::watcher`
Expected: FAIL — 5 tests panic with `not yet implemented`.

- [ ] **Step 3: Implement the pure logic and own-write registry**

Replace the five stubs in `src-tauri/src/vault/watcher.rs`:

```rust
/// Pure debounce decision: flush when there are pending changes and the vault
/// has been quiet for at least `quiet`.
pub fn should_flush(pending: bool, last_event: Option<Instant>, now: Instant, quiet: Duration) -> bool {
    pending && last_event.is_some_and(|t| now.duration_since(t) >= quiet)
}

/// Pure suppression-window decision for a registered own-write.
pub fn own_write_active(registered: Instant, now: Instant, window: Duration) -> bool {
    now.duration_since(registered) < window
}

/// Vault-relative paths that should trigger a rescan: `.md` or `.yml` files
/// with no dot-prefixed component.
pub fn is_relevant_path(path: &Path) -> bool {
    let hidden = path
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
    if hidden {
        return false;
    }
    matches!(path.extension().and_then(|e| e.to_str()), Some("md") | Some("yml"))
}

fn own_writes() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Best-effort canonicalization so registered paths match the (possibly
/// symlink-resolved) paths reported by the OS watcher.
fn normalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Record that this process just wrote `path` (called from write.rs).
pub fn note_own_write(path: &Path) {
    if let Ok(mut map) = own_writes().lock() {
        let now = Instant::now();
        map.retain(|_, t| own_write_active(*t, now, OWN_WRITE_WINDOW));
        map.insert(normalize(path), now);
    }
}

/// True while `path` is inside the own-write suppression window.
pub fn is_suppressed(path: &Path) -> bool {
    let Ok(map) = own_writes().lock() else {
        return false;
    };
    map.get(&normalize(path))
        .is_some_and(|t| own_write_active(*t, Instant::now(), OWN_WRITE_WINDOW))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::watcher`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Add the watcher runtime (state, start, debounce loop)**

Append to `src-tauri/src/vault/watcher.rs` (above the `#[cfg(test)]` block), and extend the `use` section at the top of the file to:

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use tauri::Emitter;
```

New code:

```rust
const POLL: Duration = Duration::from_millis(100);

/// Managed Tauri state holding the active watcher. Replacing it drops the
/// previous watcher, which disconnects its channel and ends its thread.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<notify::RecommendedWatcher>>);

/// Start (or replace) the vault watcher: recursive notify watcher feeding a
/// debounce thread that emits `vault-changed` (unit payload) to the frontend.
pub fn start(app: tauri::AppHandle, state: &WatcherState, vault: PathBuf) -> Result<(), String> {
    if !vault.is_dir() {
        return Err(format!("not a directory: {}", vault.display()));
    }
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
    let mut watcher = recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        if let Ok(event) = result {
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let _ = tx.send(event.paths);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&vault, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    let vault_root = normalize(&vault);
    std::thread::spawn(move || debounce_loop(app, vault_root, rx));
    let mut slot = state.0.lock().map_err(|_| "watcher state poisoned".to_string())?;
    *slot = Some(watcher);
    Ok(())
}

fn relevant_change(vault: &Path, path: &Path) -> bool {
    if is_suppressed(path) {
        return false;
    }
    let normalized = normalize(path);
    let rel = normalized.strip_prefix(vault).unwrap_or(&normalized);
    is_relevant_path(rel)
}

/// Collect change events; after 350 ms of quiet, emit one `vault-changed`.
/// Exits when the watcher (and thus the channel sender) is dropped.
fn debounce_loop(app: tauri::AppHandle, vault: PathBuf, rx: mpsc::Receiver<Vec<PathBuf>>) {
    let mut pending = false;
    let mut last_event: Option<Instant> = None;
    loop {
        match rx.recv_timeout(POLL) {
            Ok(paths) => {
                if paths.iter().any(|p| relevant_change(&vault, p)) {
                    pending = true;
                    last_event = Some(Instant::now());
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if should_flush(pending, last_event, Instant::now(), DEBOUNCE) {
            pending = false;
            last_event = None;
            let _ = app.emit(VAULT_CHANGED_EVENT, ());
        }
    }
}
```

- [ ] **Step 6: Hook own-write registration into write.rs and register the command**

In `src-tauri/src/vault/write.rs`, replace the `write_file` helper with:

```rust
/// Single funnel for all vault file writes; registers each write with the
/// watcher so our own saves don't bounce back as `vault-changed` events.
fn write_file(abs: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(abs, content).map_err(|e| e.to_string())?;
    super::watcher::note_own_write(abs);
    Ok(())
}
```

In `src-tauri/src/lib.rs`:

1. Below `use vault::write::ViewYaml;` add:

```rust
use vault::watcher::WatcherState;
```

2. Add the command (next to the other commands):

```rust
#[tauri::command]
fn start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    vault: String,
) -> Result<(), String> {
    vault::watcher::start(app, state.inner(), PathBuf::from(vault))
}
```

3. In `run()`, add `.manage(WatcherState::default())` after the dialog plugin line and add `start_watcher` to the handler list, so the builder chain reads:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            pick_vault,
            get_last_vault,
            scan_vault,
            read_note,
            save_note,
            update_frontmatter,
            create_note,
            set_note_title,
            list_views,
            save_view,
            start_watcher
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

- [ ] **Step 7: Verify the whole crate compiles and all tests pass**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — check clean; 44 tests green (39 from Tasks 4–7 plus 5 watcher tests).

- [ ] **Step 8: Commit**

```
git add src-tauri/src/vault/ src-tauri/src/lib.rs
git commit -m "feat: add debounced vault watcher with own-write suppression"
```

### Task 9: Demo vault generator + committed demo-vault/

Converts the prototype seed data (`docs/cerebro-with-teams/cerebro-work-data.js` and `cerebro-data.js`) into the committed `demo-vault/` markdown vault: 4 type notes, 5 space notes (with status sets), 4 project notes, 32 work items, 12 person notes — 57 files total. Seed items attached to a work list (`listId` instead of `projectId`) are skipped: work lists are not an M1 concept. Output is deterministic (sorted iteration, fixed key order) so re-running over unchanged seeds produces a clean git diff.

Note on the seed files (verified by inspection): both are ES modules declaring plain data as top-level `export const X = ...` with **no imports and no browser globals**. The loader therefore reads the file text, strips the `export ` keyword, evaluates the result in a `node:vm` sandbox, and harvests the needed constants via a collector callback.

**Files:**
- Create: `scripts/build-demo-vault.ts`
- Create: `demo-vault/` (generated output, committed)
- Test: `scripts/build-demo-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/build-demo-vault.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SEED_DIR,
  cssColor,
  dueIso,
  loadSeedModule,
  seedItemToFrontmatter,
  slugify,
} from './build-demo-vault';

describe('slugify', () => {
  it('lowercases, strips apostrophes, hyphenates', () => {
    expect(slugify("Maya's desk")).toBe('mayas-desk');
    expect(slugify('Launch war room')).toBe('launch-war-room');
    expect(slugify('Guided onboarding GA')).toBe('guided-onboarding-ga');
    expect(slugify('FLD-7')).toBe('fld-7');
  });
});

describe('cssColor', () => {
  it('maps var(--token) references to DS hex values', () => {
    expect(cssColor('var(--swatch-teal)')).toBe('#14B8A6');
    expect(cssColor('var(--warn-500)')).toBe('#DE8F0A');
    expect(cssColor('var(--n-400)')).toBe('#A8AFC2');
  });

  it('passes hex values through and rejects unknown tokens', () => {
    expect(cssColor('#3D8BE8')).toBe('#3D8BE8');
    expect(() => cssColor('var(--not-a-token)')).toThrow(/not-a-token/);
  });
});

describe('dueIso', () => {
  it('converts the seed dueN day number to an ISO 2026 date', () => {
    expect(dueIso(918)).toBe('2026-09-18');
    expect(dueIso(723)).toBe('2026-07-23');
    expect(dueIso(801)).toBe('2026-08-01');
  });
});

describe('seedItemToFrontmatter', () => {
  const projectSlugById = new Map([['pj-onb', 'guided-onboarding-ga']]);

  it('maps a seed work item to frontmatter with wikilinks and ISO due date', () => {
    const fm = seedItemToFrontmatter(
      {
        id: 'wi-7',
        key: 'FLD-7',
        name: 'Checklist stalls on step 3 offline',
        type: 'bug',
        status: 'progress',
        priority: 'urgent',
        assignee: 'Sam Ito',
        dueN: 722,
        estimate: 'S',
        projectId: 'pj-onb',
      },
      projectSlugById,
    );
    expect(fm).toEqual({
      type: 'Work item',
      key: 'FLD-7',
      project: '[[guided-onboarding-ga]]',
      status: 'progress',
      priority: 'urgent',
      assignee: '[[sam-ito]]',
      due: '2026-07-22',
      estimate: 'S',
    });
  });

  it('returns null for seed items attached to a work list (listId)', () => {
    const fm = seedItemToFrontmatter(
      {
        id: 'wi-18',
        key: 'TRI-1',
        name: 'App crash on photo capture (Pixel 8)',
        type: 'bug',
        status: 'progress',
        priority: 'urgent',
        assignee: 'Sam Ito',
        dueN: 722,
        estimate: 'S',
        listId: 'l-triage',
      },
      projectSlugById,
    );
    expect(fm).toBeNull();
  });
});

describe('loadSeedModule', () => {
  it('evaluates the prototype seed file and returns the requested constants', () => {
    const { SPACES, PROJECTS, WORK_ITEMS } = loadSeedModule(
      join(SEED_DIR, 'cerebro-work-data.js'),
      ['SPACES', 'PROJECTS', 'WORK_ITEMS'],
    ) as { SPACES: unknown[]; PROJECTS: unknown[]; WORK_ITEMS: unknown[] };
    expect(SPACES).toHaveLength(5);
    expect(PROJECTS).toHaveLength(4);
    expect(WORK_ITEMS.length).toBeGreaterThan(40);
  });

  it('evaluates cerebro-data.js and returns USERS', () => {
    const { USERS } = loadSeedModule(join(SEED_DIR, 'cerebro-data.js'), ['USERS']) as {
      USERS: { name: string }[];
    };
    expect(USERS).toHaveLength(12);
    expect(USERS[0].name).toBe('Maya Chen');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/build-demo-vault.test.ts`
Expected: FAIL — cannot resolve import `./build-demo-vault` (module not written yet).

- [ ] **Step 3: Write the loader and pure mapping helpers**

Create `scripts/build-demo-vault.ts` with exactly this content (the generation half is appended in Step 5):

```ts
// Generates the committed demo-vault/ from the prototype seed data in
// docs/cerebro-with-teams/. Deterministic: sorted iteration and fixed
// frontmatter key order, so a re-run over unchanged seeds diffs cleanly.
//
// Run: pnpm tsx scripts/build-demo-vault.ts

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_DIR = join(ROOT, 'docs', 'cerebro-with-teams');
const OUT_DIR = join(ROOT, 'demo-vault');

// ---------------------------------------------------------------------------
// Seed loading. The seed files declare plain data as top-level
// `export const X = ...` with no imports and no browser globals (verified by
// inspection of both files). Stripping the `export ` keyword turns each file
// into a plain script we can evaluate in a node:vm sandbox; a collector
// callback appended to the script harvests the constants we need.
// ---------------------------------------------------------------------------
export function loadSeedModule(filePath: string, names: string[]): Record<string, unknown> {
  const source = readFileSync(filePath, 'utf8');
  const script = source.replace(/^export\s+/gm, '');
  const collected: Record<string, unknown> = {};
  const context = vm.createContext({
    __collect: (bag: Record<string, unknown>) => Object.assign(collected, bag),
  });
  vm.runInContext(`${script}\n__collect({ ${names.join(', ')} });`, context, {
    filename: filePath,
  });
  return collected;
}

// Token -> hex, transcribed from docs/Cerebro Design System/tokens/colors.css.
// The vault is standalone markdown, so seed `var(--token)` colors are baked
// to hex at generation time.
export const TOKEN_HEX: Record<string, string> = {
  'n-400': '#A8AFC2',
  'n-500': '#7E8699',
  'n-700': '#3F4657',
  'cortex-400': '#6580EC',
  'cortex-500': '#3D5BDE',
  'success-500': '#1F9D61',
  'warn-500': '#DE8F0A',
  'danger-500': '#DE3B4E',
  'swatch-amber': '#EFB428',
  'swatch-blue': '#3D8BE8',
  'swatch-teal': '#14B8A6',
  'swatch-green': '#34B764',
  'swatch-violet': '#8250DC',
  'swatch-magenta': '#D8569E',
  'swatch-vermilion': '#E0562E',
  'swatch-sky': '#38BDF8',
};

export function cssColor(value: string): string {
  const m = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
  if (m === null) return value;
  const hex = TOKEN_HEX[m[1]];
  if (hex === undefined) throw new Error(`No hex mapping for token --${m[1]}`);
  return hex;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Seed dueN encodes month*100+day on a 2026 calendar (e.g. 918 -> Sep 18).
export function dueIso(dueN: number): string {
  const month = Math.floor(dueN / 100);
  const day = dueN % 100;
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- seed shapes (only the fields this generator reads) ---------------------
interface SeedStatus {
  id: string;
  group: string;
  color: string;
  hollow?: boolean;
}
interface SeedSpace {
  id: string;
  name: string;
  swatch: string;
  description?: string;
  statuses: SeedStatus[];
}
interface SeedProject {
  id: string;
  spaceId: string;
  key: string;
  name: string;
  state: string;
  description?: string;
}
export interface SeedWorkItem {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
  priority: string;
  assignee: string;
  dueN: number;
  estimate: string;
  projectId?: string;
  listId?: string;
  description?: string;
}
interface SeedUser {
  id: string;
  name: string;
  role: string;
  team: string;
}

// Pure mapping: one seed work item -> item note frontmatter (unit-tested).
// Returns null for items that should not be generated (work-list items).
export function seedItemToFrontmatter(
  item: SeedWorkItem,
  projectSlugById: Map<string, string>,
): Record<string, unknown> | null {
  // Seed items carry either projectId or listId; work lists are not M1.
  if (item.projectId === undefined) return null;
  const projectSlug = projectSlugById.get(item.projectId);
  if (projectSlug === undefined) return null;
  return {
    type: 'Work item',
    key: item.key,
    project: `[[${projectSlug}]]`,
    status: item.status,
    priority: item.priority,
    assignee: `[[${slugify(item.assignee)}]]`,
    due: dueIso(item.dueN),
    estimate: item.estimate,
  };
}

function note(frontmatter: Record<string, unknown>, title: string, body?: string): string {
  const fm = YAML.stringify(frontmatter, { lineWidth: 0 });
  return `---\n${fm}---\n\n# ${title}\n${
    body !== undefined && body !== '' ? `\n${body.trim()}\n` : ''
  }`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run scripts/build-demo-vault.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Append the vault generation half**

Append exactly this to the end of `scripts/build-demo-vault.ts`:

```ts
// ---------------------------------------------------------------------------
// Type notes. Fields blocks follow the spec examples verbatim (hand-written,
// not derived from the seed); select-option hexes are baked from DS tokens
// (project states mirror the seed PROJECT_STATES colors).
// ---------------------------------------------------------------------------
const TYPE_NOTES: Record<string, string> = {
  'type/work-item.md': `---
type: Type
icon: check-square
color: '#3D8BE8'
fields:
  status: { kind: status }
  priority:
    kind: select
    options:
      - { id: urgent, color: '#DE3B4E' }
      - { id: high, color: '#DE8F0A' }
      - { id: medium, color: '#3D8BE8' }
      - { id: low, color: '#A8AFC2' }
      - { id: none, color: '#7E8699' }
  assignee: { kind: person }
  due: { kind: date }
  estimate:
    kind: select
    options:
      - { id: XS }
      - { id: S }
      - { id: M }
      - { id: L }
      - { id: XL }
  project: { kind: relation, target: Project }
---

# Work item

Work items are the unit of delivery: tasks, bugs, and milestones tracked on project boards.
`,
  'type/space.md': `---
type: Type
icon: layers
color: '#8250DC'
---

# Space

Spaces group related projects and declare the status workflow their items move through.
`,
  'type/project.md': `---
type: Type
icon: folder-kanban
color: '#14B8A6'
fields:
  key: { kind: text }
  state:
    kind: select
    options:
      - { id: draft, color: '#A8AFC2', hollow: true }
      - { id: planning, color: '#6580EC' }
      - { id: execution, color: '#DE8F0A' }
      - { id: monitoring, color: '#38BDF8' }
      - { id: completed, color: '#1F9D61' }
  space: { kind: relation, target: Space }
---

# Project

Projects belong to a space, carry an uppercase item-key prefix, and collect work items.
`,
  'type/person.md': `---
type: Type
icon: user
color: '#38BDF8'
fields:
  role: { kind: text }
  team: { kind: text }
---

# Person

People are assignees and leads. Person notes are referenced by wikilink from work items.
`,
};

export function buildVault(): Map<string, string> {
  const work = loadSeedModule(join(SEED_DIR, 'cerebro-work-data.js'), [
    'SPACES',
    'PROJECTS',
    'WORK_ITEMS',
  ]) as unknown as { SPACES: SeedSpace[]; PROJECTS: SeedProject[]; WORK_ITEMS: SeedWorkItem[] };
  const org = loadSeedModule(join(SEED_DIR, 'cerebro-data.js'), ['USERS']) as unknown as {
    USERS: SeedUser[];
  };

  const files = new Map<string, string>();
  for (const [path, content] of Object.entries(TYPE_NOTES)) files.set(path, content);

  const spaceSlugById = new Map(work.SPACES.map((s) => [s.id, slugify(s.name)]));
  const projectSlugById = new Map(work.PROJECTS.map((p) => [p.id, slugify(p.name)]));

  const bySlug = <T>(slugOf: (x: T) => string) => (a: T, b: T) =>
    slugOf(a).localeCompare(slugOf(b));

  // Spaces: statuses mapped to { id, group, color, hollow? } with hex colors.
  for (const space of [...work.SPACES].sort(bySlug((s) => slugify(s.name)))) {
    const statuses = space.statuses.map((st) => ({
      id: st.id,
      group: st.group,
      color: cssColor(st.color),
      ...(st.hollow === true ? { hollow: true } : {}),
    }));
    files.set(
      `spaces/${slugify(space.name)}.md`,
      note({ type: 'Space', color: cssColor(space.swatch), statuses }, space.name, space.description),
    );
  }

  // Projects: key, space wikilink, state.
  for (const project of [...work.PROJECTS].sort(bySlug((p) => slugify(p.name)))) {
    const spaceSlug = spaceSlugById.get(project.spaceId);
    if (spaceSlug === undefined) throw new Error(`Unknown spaceId ${project.spaceId}`);
    files.set(
      `projects/${slugify(project.name)}.md`,
      note(
        { type: 'Project', key: project.key, space: `[[${spaceSlug}]]`, state: project.state },
        project.name,
        project.description,
      ),
    );
  }

  // Work items: skip list-attached items; body from seed description.
  for (const item of [...work.WORK_ITEMS].sort(bySlug((i) => slugify(i.key)))) {
    const fm = seedItemToFrontmatter(item, projectSlugById);
    if (fm === null) continue;
    files.set(`items/${slugify(item.key)}.md`, note(fm, item.name, item.description));
  }

  // People.
  for (const user of [...org.USERS].sort(bySlug((u) => slugify(u.name)))) {
    files.set(
      `people/${slugify(user.name)}.md`,
      note({ type: 'Person', role: user.role, team: user.team }, user.name),
    );
  }

  return files;
}

function main(): void {
  const files = buildVault();
  rmSync(OUT_DIR, { recursive: true, force: true });
  for (const path of [...files.keys()].sort()) {
    const abs = join(OUT_DIR, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, files.get(path) ?? '', 'utf8');
  }
  console.log(`demo-vault: wrote ${files.size} files`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 6: Generate the vault and verify the output**

Run: `pnpm tsx scripts/build-demo-vault.ts && find demo-vault -name '*.md' | wc -l && cat demo-vault/items/fld-7.md`
Expected: prints `demo-vault: wrote 57 files`, then `57` (4 type + 5 spaces + 4 projects + 32 items + 12 people), then `items/fld-7.md` reading (string quoting produced by the yaml package may vary between `"` and `'`; keys, values, and order must match):

```
---
type: Work item
key: FLD-7
project: "[[guided-onboarding-ga]]"
status: progress
priority: urgent
assignee: "[[sam-ito]]"
due: 2026-07-22
estimate: S
---

# Checklist stalls on step 3 offline
```

Also spot-check `cat demo-vault/spaces/operations.md` — it must contain `type: Space`, a hex `color:`, and a `statuses:` list with `todo/progress/blocked/done/wontdo` entries carrying `group` and hex `color` (with `hollow: true` on `todo`). Run the generator a second time and confirm `git status` shows no changes under `demo-vault/` (determinism).

Run: `pnpm vitest run scripts/build-demo-vault.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add scripts/build-demo-vault.ts scripts/build-demo-vault.test.ts demo-vault && git commit -m "feat: generate demo vault from prototype seed data"
```

---

### Task 10: IPC layer — ipc.ts facade, mockParse.ts minimal parser, mockIpc.ts in-memory vault

`src/lib/ipc.ts` exports the exact functions from the IPC table in the shared contracts. Inside Tauri (detected via `'__TAURI_INTERNALS__' in window`) each function invokes the corresponding Rust command through `@tauri-apps/api/core`; otherwise it delegates to `src/lib/mockIpc.ts` — an in-memory `Map<string, string>` seeded from the committed `demo-vault/` via `import.meta.glob(..., { query: '?raw' })`. The mock needs to turn raw markdown into `Entry` records, so `src/lib/mockParse.ts` implements a minimal TS parser (frontmatter via the `yaml` package, title from the first H1, wikilink regex identical to the Rust parser). Cross-language parity is pinned by three shared fixture strings asserted here and in the Rust tests.

**Files:**
- Create: `src/engine/types.ts` (authoritative contract — skip if an identical file already exists)
- Create: `src/lib/mockParse.ts`
- Create: `src/lib/mockIpc.ts`
- Create: `src/lib/ipc.ts`
- Test: `src/lib/mockParse.test.ts`
- Test: `src/lib/mockIpc.test.ts`
- Test: `src/lib/ipc.test.ts`

- [ ] **Step 1: Create the engine types contract**

If `src/engine/types.ts` already exists with this content, skip. Otherwise create it with exactly the authoritative contract from the plan spine:

```ts
export type Scalar = string | number | boolean | null;

export interface Entry {
  path: string;                 // vault-relative, e.g. "items/fld-7.md"
  filename: string;             // "fld-7.md"
  title: string;                // first H1, else humanized filename stem
  type: string | null;          // frontmatter `type`
  properties: Record<string, Scalar | Scalar[]>;   // scalar frontmatter (non-wikilink)
  relationships: Record<string, string[]>;         // wikilink-valued fields → raw targets
  outgoingLinks: string[];      // wikilink targets found in the body
  snippet: string;              // first ~160 chars of body text, markdown-stripped
  createdAt: string;            // ISO 8601
  modifiedAt: string;           // ISO 8601
  parseError: string | null;    // YAML error message, or null
}

export type FieldKind =
  | 'text' | 'number' | 'checkbox' | 'date' | 'daterange'
  | 'select' | 'multiselect' | 'status' | 'person' | 'relation';

export interface FieldOption { id: string; label: string; color: string | null; hollow?: boolean }
export interface StatusDef extends FieldOption { group: 'active' | 'done' | 'closed' }
export interface FieldDef { name: string; kind: FieldKind; options?: FieldOption[]; target?: string }
export interface TypeDef { name: string; icon: string | null; color: string | null; fields: FieldDef[] }

export interface ResolvedField {
  def: FieldDef | null;         // null → undeclared field (advisory: still shown as text)
  raw: unknown;
  display: string;              // '' when empty
  color: string | null;
  ghost: boolean;               // value not in the declared option set
}

export type Selection =
  | { kind: 'home' }
  | { kind: 'space'; path: string }
  | { kind: 'project'; path: string }
  | { kind: 'view'; id: string }       // id = filename stem in views/
  | { kind: 'settings' };

export interface Presentation {
  type: 'list' | 'board';
  groupBy: string | null;              // field name; null = flat list
  orderBy: { field: string; dir: 'asc' | 'desc' };
  visibleFields: string[];
}

export type FilterOp =
  | 'equals' | 'not_equals' | 'contains' | 'any_of' | 'none_of'
  | 'is_empty' | 'is_not_empty' | 'before' | 'after';
export interface FilterRule { field: string; op: FilterOp; value?: Scalar | Scalar[] }
export type FilterGroup = { all: (FilterRule | FilterGroup)[] } | { any: (FilterRule | FilterGroup)[] };

export interface ViewDefinition {
  name: string; icon: string | null; color: string | null; order: number | null;
  filters: FilterGroup | null; presentation: Presentation;
}
export interface ViewFile { id: string; definition: ViewDefinition }

export interface Group { key: string; label: string; color: string | null; ghost: boolean; entries: Entry[] }

export interface Schema {
  types: Map<string, TypeDef>;
  spaceForEntry(e: Entry): Entry | null;                    // item → project → space (via relationships)
  statusSetForSpace(spacePath: string | null): StatusDef[]; // null/space w/o statuses → DEFAULT_STATUSES
  resolveField(e: Entry, field: string): ResolvedField;
}
```

- [ ] **Step 2: Write the failing mockParse test (cross-language parity fixtures)**

Create `src/lib/mockParse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractWikilinks, humanize, parseNote, splitFrontmatter } from './mockParse';

// CROSS-LANGUAGE PARITY FIXTURES
// These three fixture strings are also asserted by the Rust parser tests in
// src-tauri/src/vault/parse.rs (Task 4). If a fixture or an expected value
// changes here it must change there too: the mock parser and the Rust scanner
// must produce the same Entry for the same file content.

const FIXTURE_ITEM = `---
type: Work item
key: FLD-7
status: progress
priority: urgent
project: "[[guided-onboarding-ga]]"
---

# Checklist stalls on step 3 offline

Steps to reproduce the stall, see [[offline-sync-hardening]].
`;

const FIXTURE_BAD_YAML = `---
type: [unclosed
status: todo
---

# Broken note
`;

const FIXTURE_PLAIN = `Just a plain paragraph that links to [[field-platform]].
`;

const T = '2026-07-24T00:00:00.000Z';

describe('parseNote parity fixtures', () => {
  it('parses frontmatter, title, relationships and body links (fixture 1)', () => {
    const e = parseNote('items/fld-7.md', FIXTURE_ITEM, T, T);
    expect(e.path).toBe('items/fld-7.md');
    expect(e.filename).toBe('fld-7.md');
    expect(e.title).toBe('Checklist stalls on step 3 offline');
    expect(e.type).toBe('Work item');
    expect(e.properties.key).toBe('FLD-7');
    expect(e.properties.status).toBe('progress');
    expect(e.properties.priority).toBe('urgent');
    expect(e.properties).not.toHaveProperty('project');
    expect(e.relationships.project).toEqual(['guided-onboarding-ga']);
    expect(e.outgoingLinks).toEqual(['offline-sync-hardening']);
    expect(e.snippet).toBe('Steps to reproduce the stall, see offline-sync-hardening.');
    expect(e.parseError).toBeNull();
  });

  it('keeps a malformed-YAML file as an entry with parseError set (fixture 2)', () => {
    const e = parseNote('items/broken.md', FIXTURE_BAD_YAML, T, T);
    expect(e.parseError).not.toBeNull();
    expect(e.properties).toEqual({});
    expect(e.relationships).toEqual({});
    expect(e.type).toBeNull();
    expect(e.title).toBe('Broken note');
  });

  it('handles no frontmatter and no H1 (fixture 3)', () => {
    const e = parseNote('notes/meeting-notes.md', FIXTURE_PLAIN, T, T);
    expect(e.title).toBe('Meeting notes');
    expect(e.type).toBeNull();
    expect(e.properties).toEqual({});
    expect(e.outgoingLinks).toEqual(['field-platform']);
    expect(e.snippet).toBe('Just a plain paragraph that links to field-platform.');
    expect(e.parseError).toBeNull();
  });
});

describe('helpers', () => {
  it('extractWikilinks pulls targets from strings and string arrays', () => {
    expect(extractWikilinks('[[a]]')).toEqual(['a']);
    expect(extractWikilinks('before [[a]] and [[b]]')).toEqual(['a', 'b']);
    expect(extractWikilinks(['[[a]]', '[[b]]'])).toEqual(['a', 'b']);
    expect(extractWikilinks('plain text')).toBeNull();
    expect(extractWikilinks(7)).toBeNull();
    expect(extractWikilinks(null)).toBeNull();
  });

  it('humanize turns a filename stem into a title', () => {
    expect(humanize('fld-7')).toBe('Fld 7');
    expect(humanize('meeting-notes')).toBe('Meeting notes');
  });

  it('splitFrontmatter returns null yaml when there is no fence', () => {
    expect(splitFrontmatter('hello')).toEqual({ yaml: null, body: 'hello' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/lib/mockParse.test.ts`
Expected: FAIL — cannot resolve import `./mockParse`.

- [ ] **Step 4: Implement mockParse.ts**

Create `src/lib/mockParse.ts`:

```ts
// Minimal TS re-implementation of the Rust note parser, used ONLY by the mock
// IPC backend (browser dev, vitest, Playwright). The Rust scanner in
// src-tauri/src/vault/parse.rs is the source of truth inside Tauri.
//
// PARITY: the wikilink regex, humanize rule, and snippet rules below
// intentionally mirror parse.rs. The shared fixtures in mockParse.test.ts are
// asserted by both implementations — keep them in sync.
import YAML from 'yaml';
import type { Entry, Scalar } from '@/engine/types';

// Identical to the Rust wikilink pattern: [[target]], no nested brackets.
export const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;

/** Wikilink targets from a frontmatter value; null when the value has none. */
export function extractWikilinks(value: unknown): string[] | null {
  const texts: string[] = [];
  if (typeof value === 'string') texts.push(value);
  else if (Array.isArray(value)) {
    for (const v of value) if (typeof v === 'string') texts.push(v);
  } else return null;
  const targets: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(WIKILINK_RE)) targets.push(m[1].trim());
  }
  return targets.length > 0 ? targets : null;
}

/** 'meeting-notes' -> 'Meeting notes' (parity with the Rust fallback title). */
export function humanize(stem: string): string {
  const spaced = stem.replace(/[-_]+/g, ' ').trim();
  return spaced === '' ? stem : spaced[0].toUpperCase() + spaced.slice(1);
}

export function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { yaml: null, body: raw };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { yaml: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
    }
  }
  return { yaml: null, body: raw }; // unterminated fence: treat whole file as body
}

function makeSnippet(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^#{1,6}\s/.test(line))
    .join(' ')
    .replace(WIKILINK_RE, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function parseNote(path: string, raw: string, createdAt: string, modifiedAt: string): Entry {
  const filename = path.split('/').pop() ?? path;
  const stem = filename.replace(/\.md$/, '');
  const { yaml, body } = splitFrontmatter(raw);

  let frontmatter: Record<string, unknown> = {};
  let parseError: string | null = null;
  if (yaml !== null) {
    try {
      const parsed: unknown = YAML.parse(yaml);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  const properties: Record<string, Scalar | Scalar[]> = {};
  const relationships: Record<string, string[]> = {};
  let entryType: string | null = null;
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'type' && typeof value === 'string') {
      entryType = value;
      continue;
    }
    const links = extractWikilinks(value);
    if (links !== null) {
      relationships[key] = links;
    } else {
      // Nested YAML (e.g. a space's `statuses` list) passes through unchanged
      // so the schema layer sees the same shape the Rust scanner produces
      // (serde_json::Value); the Scalar typing is advisory here.
      properties[key] = value as Scalar | Scalar[];
    }
  }

  const h1 = /^#\s+(.+)$/m.exec(body);
  return {
    path,
    filename,
    title: h1 !== null ? h1[1].trim() : humanize(stem),
    type: entryType,
    properties,
    relationships,
    outgoingLinks: [...body.matchAll(WIKILINK_RE)].map((m) => m[1].trim()),
    snippet: makeSnippet(body),
    createdAt,
    modifiedAt,
    parseError,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/lib/mockParse.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit the parser**

```
git add src/engine/types.ts src/lib/mockParse.ts src/lib/mockParse.test.ts && git commit -m "feat: add engine types and minimal TS note parser for mock IPC"
```

- [ ] **Step 7: Write the failing mockIpc test**

Create `src/lib/mockIpc.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from './mockIpc';

beforeEach(() => {
  mock.resetMockFs();
});

describe('mockIpc', () => {
  it('pickVault and getLastVault return the demo vault path', async () => {
    expect(await mock.pickVault()).toBe('/demo-vault');
    expect(await mock.getLastVault()).toBe('/demo-vault');
  });

  it('scanVault parses the seeded demo vault into entries', async () => {
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.every((e) => e.parseError === null)).toBe(true);
    const item = entries.find((e) => e.path === 'items/fld-1.md');
    expect(item?.title).toBe('First-run walkthrough GA');
    expect(item?.type).toBe('Work item');
    expect(item?.properties.key).toBe('FLD-1');
    expect(item?.relationships.project).toEqual(['guided-onboarding-ga']);
    expect(item?.relationships.assignee).toEqual(['ana-rios']);
  });

  it('exposes the file map for Playwright assertions', () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs).toBeInstanceOf(Map);
    expect(fs.has('items/fld-1.md')).toBe(true);
  });

  it('readNote returns the body with frontmatter stripped', async () => {
    const body = await mock.readNote('/demo-vault', 'items/fld-1.md');
    expect(body.startsWith('# First-run walkthrough GA')).toBe(true);
    expect(body).not.toContain('---');
  });

  it('updateFrontmatter patches values, deletes nulls, preserves order and unknown keys', async () => {
    await mock.updateFrontmatter('/demo-vault', 'items/fld-1.md', { status: 'done', due: null });
    const entries = await mock.scanVault('/demo-vault');
    const item = entries.find((e) => e.path === 'items/fld-1.md');
    expect(item?.properties.status).toBe('done');
    expect(item?.properties).not.toHaveProperty('due');
    expect(item?.properties.estimate).toBe('XL'); // untouched key preserved
    const raw = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.get(
      'items/fld-1.md',
    ) as string;
    expect(raw.indexOf('type:')).toBeLessThan(raw.indexOf('key:')); // key order preserved
    expect(raw).toContain('project:'); // unknown-to-the-patch key preserved
  });

  it('createNote dedupes slugs with -2, -3 and returns the vault-relative path', async () => {
    const path = await mock.createNote(
      '/demo-vault',
      'items',
      'fld-1',
      { type: 'Work item', key: 'FLD-99' },
      '',
    );
    expect(path).toBe('items/fld-1-2.md');
    const again = await mock.createNote('/demo-vault', 'items', 'fld-1', { type: 'Work item' }, '');
    expect(again).toBe('items/fld-1-3.md');
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.find((e) => e.path === 'items/fld-1-2.md')?.properties.key).toBe('FLD-99');
  });

  it('setNoteTitle rewrites the first H1', async () => {
    await mock.setNoteTitle('/demo-vault', 'items/fld-1.md', 'Renamed walkthrough');
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.find((e) => e.path === 'items/fld-1.md')?.title).toBe('Renamed walkthrough');
  });

  it('listViews is empty for the demo vault and saveView round-trips', async () => {
    expect(await mock.listViews('/demo-vault')).toEqual([]);
    await mock.saveView('/demo-vault', 'my-view', 'name: My view\n');
    expect(await mock.listViews('/demo-vault')).toEqual([
      { id: 'my-view', yaml: 'name: My view\n' },
    ]);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm vitest run src/lib/mockIpc.test.ts`
Expected: FAIL — cannot resolve import `./mockIpc`.

- [ ] **Step 9: Implement mockIpc.ts**

Create `src/lib/mockIpc.ts`:

```ts
// In-memory IPC backend for browser dev, vitest, and Playwright. The whole
// "disk" is a Map<vault-relative path, raw file content>, seeded at module
// load from the committed demo-vault/ and mutated by the write commands.
// The map is exposed as window.__cerebroMockFs so Playwright can assert on
// "disk" state. 'vault-changed' has no equivalent here: startWatcher is a
// no-op and writers trigger rescans directly (see vaultStore).
import YAML from 'yaml';
import type { Entry } from '@/engine/types';
import { parseNote, splitFrontmatter } from './mockParse';

const SEED_TIME = '2026-07-24T00:00:00.000Z';

const seededNotes = import.meta.glob('/demo-vault/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const seededViews = import.meta.glob('/demo-vault/views/*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const files = new Map<string, string>();
const times = new Map<string, { createdAt: string; modifiedAt: string }>();

/** Re-seed the mock filesystem from demo-vault/. Exported for test isolation. */
export function resetMockFs(): void {
  files.clear();
  times.clear();
  for (const [absPath, raw] of Object.entries({ ...seededNotes, ...seededViews })) {
    const rel = absPath.replace(/^\/demo-vault\//, '');
    files.set(rel, raw);
    times.set(rel, { createdAt: SEED_TIME, modifiedAt: SEED_TIME });
  }
}
resetMockFs();

if (typeof window !== 'undefined') {
  (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs = files;
}

function touch(path: string): void {
  const now = new Date().toISOString();
  const prev = times.get(path);
  times.set(path, { createdAt: prev?.createdAt ?? now, modifiedAt: now });
}

function mustGet(path: string): string {
  const raw = files.get(path);
  if (raw === undefined) throw new Error(`Note not found: ${path}`);
  return raw;
}

export async function pickVault(): Promise<string | null> {
  return '/demo-vault';
}

export async function getLastVault(): Promise<string | null> {
  return '/demo-vault';
}

export async function scanVault(_vault: string): Promise<Entry[]> {
  const paths = [...files.keys()].filter((p) => p.endsWith('.md')).sort();
  return paths.map((p) => {
    const t = times.get(p) ?? { createdAt: SEED_TIME, modifiedAt: SEED_TIME };
    return parseNote(p, files.get(p) ?? '', t.createdAt, t.modifiedAt);
  });
}

export async function readNote(_vault: string, path: string): Promise<string> {
  return splitFrontmatter(mustGet(path)).body.replace(/^\n+/, '');
}

export async function saveNote(_vault: string, path: string, body: string): Promise<void> {
  const { yaml } = splitFrontmatter(mustGet(path));
  files.set(path, yaml !== null ? `---\n${yaml}\n---\n\n${body}` : body);
  touch(path);
}

export async function updateFrontmatter(
  _vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { yaml, body } = splitFrontmatter(mustGet(path));
  // parseDocument preserves key order and untouched keys on round-trip.
  const doc = YAML.parseDocument(yaml ?? '');
  if (doc.contents === null) doc.contents = doc.createNode({}) as typeof doc.contents;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
  files.set(path, `---\n${doc.toString()}---\n${body}`);
  touch(path);
}

export async function createNote(
  _vault: string,
  folder: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  let finalSlug = slug;
  for (let n = 2; files.has(`${folder}/${finalSlug}.md`); n++) finalSlug = `${slug}-${n}`;
  const path = `${folder}/${finalSlug}.md`;
  files.set(path, `---\n${YAML.stringify(frontmatter)}---\n\n${body}`);
  touch(path);
  return path;
}

export async function setNoteTitle(_vault: string, path: string, title: string): Promise<void> {
  const { yaml, body } = splitFrontmatter(mustGet(path));
  const lines = body.split('\n');
  const h1Index = lines.findIndex((line) => /^#\s+/.test(line));
  if (h1Index >= 0) {
    lines[h1Index] = `# ${title}`;
  } else {
    let insertAt = 0;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    lines.splice(insertAt, 0, `# ${title}`, '');
  }
  const newBody = lines.join('\n');
  files.set(path, yaml !== null ? `---\n${yaml}\n---\n${newBody}` : newBody);
  touch(path);
}

export async function listViews(_vault: string): Promise<{ id: string; yaml: string }[]> {
  return [...files.keys()]
    .filter((p) => p.startsWith('views/') && p.endsWith('.yml'))
    .sort()
    .map((p) => ({ id: p.slice('views/'.length, -'.yml'.length), yaml: files.get(p) ?? '' }));
}

export async function saveView(_vault: string, id: string, yaml: string): Promise<void> {
  files.set(`views/${id}.yml`, yaml);
  touch(`views/${id}.yml`);
}

export async function startWatcher(_vault: string): Promise<void> {
  // No-op: the mock has no file watcher; writers trigger rescans directly.
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm vitest run src/lib/mockIpc.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 11: Write the failing ipc facade test**

Create `src/lib/ipc.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeSpy } = vi.hoisted(() => ({ invokeSpy: vi.fn(async () => [] as unknown) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeSpy }));

import { scanVault, updateFrontmatter } from './ipc';

afterEach(() => {
  invokeSpy.mockClear();
  delete (window as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('ipc backend detection', () => {
  it('delegates to the mock when not running inside Tauri', async () => {
    const entries = await scanVault('/demo-vault');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes Tauri commands when __TAURI_INTERNALS__ is present', async () => {
    (window as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await scanVault('/my-vault');
    expect(invokeSpy).toHaveBeenCalledWith('scan_vault', { vault: '/my-vault' });
    await updateFrontmatter('/my-vault', 'items/a.md', { status: 'done' });
    expect(invokeSpy).toHaveBeenCalledWith('update_frontmatter', {
      vault: '/my-vault',
      path: 'items/a.md',
      patch: { status: 'done' },
    });
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ipc.test.ts`
Expected: FAIL — cannot resolve import `./ipc`.

- [ ] **Step 13: Implement ipc.ts**

Create `src/lib/ipc.ts`:

```ts
// IPC facade: every vault operation in the app goes through these functions.
// Inside Tauri (detected via __TAURI_INTERNALS__) they invoke the Rust
// commands; in the browser (pnpm dev, vitest, Playwright) they delegate to
// the in-memory mock in mockIpc.ts. Signatures follow the plan's IPC table.
import type { Entry } from '@/engine/types';
import * as mock from './mockIpc';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function pickVault(): Promise<string | null> {
  return inTauri() ? invokeTauri('pick_vault') : mock.pickVault();
}

export function getLastVault(): Promise<string | null> {
  return inTauri() ? invokeTauri('get_last_vault') : mock.getLastVault();
}

export function scanVault(vault: string): Promise<Entry[]> {
  return inTauri() ? invokeTauri('scan_vault', { vault }) : mock.scanVault(vault);
}

export function readNote(vault: string, path: string): Promise<string> {
  return inTauri() ? invokeTauri('read_note', { vault, path }) : mock.readNote(vault, path);
}

export function saveNote(vault: string, path: string, body: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_note', { vault, path, body })
    : mock.saveNote(vault, path, body);
}

export function updateFrontmatter(
  vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  return inTauri()
    ? invokeTauri('update_frontmatter', { vault, path, patch })
    : mock.updateFrontmatter(vault, path, patch);
}

export function createNote(
  vault: string,
  folder: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  return inTauri()
    ? invokeTauri('create_note', { vault, folder, slug, frontmatter, body })
    : mock.createNote(vault, folder, slug, frontmatter, body);
}

export function setNoteTitle(vault: string, path: string, title: string): Promise<void> {
  return inTauri()
    ? invokeTauri('set_note_title', { vault, path, title })
    : mock.setNoteTitle(vault, path, title);
}

export function listViews(vault: string): Promise<{ id: string; yaml: string }[]> {
  return inTauri() ? invokeTauri('list_views', { vault }) : mock.listViews(vault);
}

export function saveView(vault: string, id: string, yaml: string): Promise<void> {
  return inTauri() ? invokeTauri('save_view', { vault, id, yaml }) : mock.saveView(vault, id, yaml);
}

export function startWatcher(vault: string): Promise<void> {
  return inTauri() ? invokeTauri('start_watcher', { vault }) : mock.startWatcher(vault);
}
```

- [ ] **Step 14: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/ipc.test.ts src/lib/mockIpc.test.ts src/lib/mockParse.test.ts`
Expected: PASS (all three files green).

- [ ] **Step 15: Commit**

```
git add src/lib/mockIpc.ts src/lib/mockIpc.test.ts src/lib/ipc.ts src/lib/ipc.test.ts && git commit -m "feat: add IPC facade with Tauri detection and in-memory mock vault"
```

---

### Task 11: vaultStore with optimistic patching, useEntry, useSchema

Zustand store implementing the `VaultState` contract: `openVault` (scan + parse views + start watcher + subscribe to `vault-changed` when in Tauri), `rescan`, `patchFrontmatter` (optimistic local update re-derived from the patch — string wikilink values become relationships — then disk write; the mock reconciles on write completion, Tauri reconciles on the watcher event; failures revert by rescanning), and `createItem`. Also exports `useEntry(path)` and `useSchema()` (a memoized `buildSchema` over the entries array).

`vaultStore` imports `parseViewYaml` from `@/engine/views` (full implementation lands in Task 15) and `buildSchema` from `@/engine/schema` (Task 13). So the store compiles and runs now, this task creates clearly-marked placeholder modules for both — **only if the files do not exist yet**. Tests stub `@/engine/schema` with `vi.mock` so they are independent of which version is on disk. Wikilink extraction reuses `extractWikilinks` from `@/lib/mockParse` (the canonical `engine/wikilink.ts` arrives in Task 12).

**Files:**
- Create: `src/stores/vaultStore.ts`
- Create: `src/engine/schema.ts` (placeholder — skip if it already exists; Task 13 replaces it)
- Create: `src/engine/views.ts` (placeholder — skip if it already exists; Task 15 replaces it)
- Test: `src/stores/vaultStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/stores/vaultStore.test.ts`:

```ts
// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine/schema', () => ({
  buildSchema: vi.fn(() => ({ types: new Map() })),
}));

import { buildSchema } from '@/engine/schema';
import { resetMockFs } from '@/lib/mockIpc';
import { getSchema, useEntry, useVaultStore } from '@/stores/vaultStore';

function findEntry(path: string) {
  return useVaultStore.getState().entries.find((e) => e.path === path);
}

beforeEach(() => {
  resetMockFs();
  vi.mocked(buildSchema).mockClear();
  useVaultStore.setState({ vaultPath: null, entries: [], views: [], status: 'idle', error: null });
});

describe('vaultStore', () => {
  it('openVault scans the demo vault into entries and views', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const s = useVaultStore.getState();
    expect(s.status).toBe('ready');
    expect(s.vaultPath).toBe('/demo-vault');
    expect(s.entries.length).toBeGreaterThan(50);
    expect(Array.isArray(s.views)).toBe(true);
    const item = findEntry('items/fld-1.md');
    expect(item?.title).toBe('First-run walkthrough GA');
    expect(item?.relationships.project).toEqual(['guided-onboarding-ga']);
  });

  it('patchFrontmatter applies optimistically before the write resolves', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const pending = useVaultStore
      .getState()
      .patchFrontmatter('items/fld-1.md', { status: 'done', assignee: '[[sam-ito]]' });
    // Synchronously visible: scalar to properties, wikilink to relationships.
    expect(findEntry('items/fld-1.md')?.properties.status).toBe('done');
    expect(findEntry('items/fld-1.md')?.relationships.assignee).toEqual(['sam-ito']);
    await pending;
    // Survives the reconciling rescan because the mock disk was updated too.
    expect(findEntry('items/fld-1.md')?.properties.status).toBe('done');
    expect(findEntry('items/fld-1.md')?.relationships.assignee).toEqual(['sam-ito']);
  });

  it('patchFrontmatter with null deletes the field', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    await useVaultStore.getState().patchFrontmatter('items/fld-1.md', { due: null });
    expect(findEntry('items/fld-1.md')?.properties).not.toHaveProperty('due');
  });

  it('createItem returns the new path and the entry appears after rescan', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const path = await useVaultStore.getState().createItem({
      folder: 'items',
      slug: 'fld-99',
      frontmatter: {
        type: 'Work item',
        key: 'FLD-99',
        status: 'todo',
        project: '[[guided-onboarding-ga]]',
      },
    });
    expect(path).toBe('items/fld-99.md');
    const entry = findEntry(path);
    expect(entry?.properties.key).toBe('FLD-99');
    expect(entry?.relationships.project).toEqual(['guided-onboarding-ga']);
  });

  it('getSchema memoizes buildSchema per entries reference', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const entries = useVaultStore.getState().entries;
    const a = getSchema(entries);
    const b = getSchema(entries);
    expect(a).toBe(b);
    expect(vi.mocked(buildSchema)).toHaveBeenCalledTimes(1);
  });

  it('useEntry returns the entry for a path', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const { result } = renderHook(() => useEntry('items/fld-1.md'));
    expect(result.current?.title).toBe('First-run walkthrough GA');
    const { result: missing } = renderHook(() => useEntry('items/nope.md'));
    expect(missing.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/stores/vaultStore.test.ts`
Expected: FAIL — cannot resolve import `@/stores/vaultStore`.

- [ ] **Step 3: Create the engine placeholders (only if absent)**

If `src/engine/schema.ts` does NOT exist yet, create it:

```ts
// PLACEHOLDER — created in Task 11 so vaultStore can link against the schema
// module. Task 13 REPLACES this file with the full implementation. Do not
// build on the bodies below; only the exported names and signatures matter.
import type { Entry, ResolvedField, Schema, StatusDef } from './types';

export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'backlog', label: 'Backlog', color: '#A8AFC2', group: 'active' },
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'in-progress', label: 'In progress', color: '#EFB428', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
  { id: 'cancelled', label: 'Cancelled', color: '#A8AFC2', group: 'closed', hollow: true },
];

export function buildSchema(_entries: Entry[]): Schema {
  return {
    types: new Map(),
    spaceForEntry: () => null,
    statusSetForSpace: () => DEFAULT_STATUSES,
    resolveField: (e: Entry, field: string): ResolvedField => {
      const raw = e.properties[field] ?? null;
      return { def: null, raw, display: raw === null ? '' : String(raw), color: null, ghost: false };
    },
  };
}
```

If `src/engine/views.ts` does NOT exist yet, create it:

```ts
// PLACEHOLDER — created in Task 11 so vaultStore can parse saved views. Task
// 15 REPLACES this file with the full tolerant parser plus serializeView.
import type { ViewFile } from './types';

export function parseViewYaml(id: string, _yaml: string): ViewFile {
  return {
    id,
    definition: {
      name: id,
      icon: null,
      color: null,
      order: null,
      filters: null,
      presentation: {
        type: 'list',
        groupBy: 'status',
        orderBy: { field: 'modifiedAt', dir: 'desc' },
        visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
      },
    },
  };
}
```

- [ ] **Step 4: Implement vaultStore.ts**

Create `src/stores/vaultStore.ts`:

```ts
import { create } from 'zustand';
import { buildSchema } from '@/engine/schema';
import type { Entry, Scalar, Schema, ViewFile } from '@/engine/types';
import { parseViewYaml } from '@/engine/views';
import * as ipc from '@/lib/ipc';
import { extractWikilinks } from '@/lib/mockParse';

export interface VaultState {
  vaultPath: string | null;
  entries: Entry[];
  views: ViewFile[];
  status: 'idle' | 'scanning' | 'ready' | 'error';
  error: string | null;
  openVault(path: string): Promise<void>;
  rescan(): Promise<void>;
  patchFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;
  createItem(args: {
    folder: string;
    slug: string;
    frontmatter: Record<string, unknown>;
    body?: string;
  }): Promise<string>;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Re-derive an entry's properties/relationships from an optimistic patch:
// null deletes the field, values containing [[wikilinks]] become
// relationships, everything else lands in properties. Mirrors the split the
// Rust parser performs on the next scan, so the optimistic entry and the
// rescanned entry agree.
function applyPatch(entry: Entry, patch: Record<string, unknown>): Entry {
  const properties = { ...entry.properties };
  const relationships = { ...entry.relationships };
  for (const [key, value] of Object.entries(patch)) {
    delete properties[key];
    delete relationships[key];
    if (value === null || value === undefined) continue;
    const links = extractWikilinks(value);
    if (links !== null) relationships[key] = links;
    else properties[key] = value as Scalar | Scalar[];
  }
  return { ...entry, properties, relationships, modifiedAt: new Date().toISOString() };
}

let watcherBound = false;

export const useVaultStore = create<VaultState>()((set, get) => ({
  vaultPath: null,
  entries: [],
  views: [],
  status: 'idle',
  error: null,

  async openVault(path) {
    set({ vaultPath: path, status: 'scanning', error: null });
    try {
      const entries = await ipc.scanVault(path);
      const views = (await ipc.listViews(path)).map((v) => parseViewYaml(v.id, v.yaml));
      await ipc.startWatcher(path);
      if (inTauri() && !watcherBound) {
        watcherBound = true;
        const { listen } = await import('@tauri-apps/api/event');
        await listen('vault-changed', () => {
          void get().rescan();
        });
      }
      set({ entries, views, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  async rescan() {
    const vault = get().vaultPath;
    if (vault === null) return;
    const entries = await ipc.scanVault(vault);
    const views = (await ipc.listViews(vault)).map((v) => parseViewYaml(v.id, v.yaml));
    set({ entries, views, status: 'ready' });
  },

  async patchFrontmatter(path, patch) {
    const vault = get().vaultPath;
    if (vault === null) return;
    // Optimistic: local state updates synchronously, before the disk write.
    set({ entries: get().entries.map((e) => (e.path === path ? applyPatch(e, patch) : e)) });
    try {
      await ipc.updateFrontmatter(vault, path, patch);
      // In Tauri the watcher's vault-changed event reconciles; the mock has
      // no watcher, so reconcile on write completion.
      if (!inTauri()) await get().rescan();
    } catch {
      await get().rescan(); // disk truth wins: revert the optimistic update
    }
  },

  async createItem({ folder, slug, frontmatter, body = '' }) {
    const vault = get().vaultPath;
    if (vault === null) throw new Error('No vault open');
    const path = await ipc.createNote(vault, folder, slug, frontmatter, body);
    if (!inTauri()) await get().rescan();
    return path;
  },
}));

let schemaCache: { entries: Entry[]; schema: Schema } | null = null;

/** Memoized buildSchema: recomputes only when the entries array identity changes. */
export function getSchema(entries: Entry[]): Schema {
  if (schemaCache === null || schemaCache.entries !== entries) {
    schemaCache = { entries, schema: buildSchema(entries) };
  }
  return schemaCache.schema;
}

export function useSchema(): Schema {
  return getSchema(useVaultStore((s) => s.entries));
}

export function useEntry(path: string | null): Entry | null {
  return useVaultStore((s) =>
    path === null ? null : (s.entries.find((e) => e.path === path) ?? null),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/stores/vaultStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```
git add src/stores/vaultStore.ts src/stores/vaultStore.test.ts src/engine/schema.ts src/engine/views.ts && git commit -m "feat: add vault store with optimistic frontmatter patching"
```

### Task 12: Engine — wikilink parsing and frontmatter normalization

**Prerequisites:** Task 1 (Vitest running), and `src/engine/types.ts` (created in Task 10; authoritative contents are in this plan's "Shared contracts" section — if it does not exist yet, create it verbatim from that block first).

This task creates the two lowest-level engine modules plus a shared test fixture helper used by every engine test file:

- `parseWikilinks(value)` — detects `[[wikilink]]` values in frontmatter (string or string array, piped aliases `[[target|Alias]]` resolve to `target`); returns `null` for any value containing no wikilinks.
- `formatWikilink(target)` / `resolveTarget(target, entries)` — round-trip and resolution (filename-stem match first, then exact title match, case-insensitive).
- `normalizeValue(value)` — frontmatter scalar normalization (trim, empty string → `null`, date-like strings stay strings, `Date` instances → `YYYY-MM-DD` strings).
- `normalizeFrontmatter(fm)` — splits a raw frontmatter mapping into `{properties, relationships}` (used by `mockIpc.ts`; nested mappings like `fields`/`statuses` pass through untouched so `schema.ts` can parse them; the `type` key is excluded because `Entry.type` is extracted separately).

**Files:**
- Create: `src/engine/testHelpers.ts`
- Create: `src/engine/wikilink.ts`
- Create: `src/engine/normalize.ts`
- Test: `src/engine/wikilink.test.ts`
- Test: `src/engine/normalize.test.ts`

- [ ] **Step 1: Create the shared test fixture helper**

Create `src/engine/testHelpers.ts` (test-support only — no production imports):

```ts
import type { Entry } from './types';

type EntryPatch = Partial<Omit<Entry, 'properties'>> & {
  /**
   * Loosened to `unknown` values so tests can pass nested mappings
   * (`fields`, `statuses`) exactly the way the Rust parser stores them
   * in `properties` as raw JSON values.
   */
  properties?: Record<string, unknown>;
};

export function makeEntry(patch: EntryPatch = {}): Entry {
  const { properties, ...rest } = patch;
  return {
    path: 'items/item.md',
    filename: 'item.md',
    title: 'Item',
    type: null,
    properties: (properties ?? {}) as Entry['properties'],
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    modifiedAt: '2026-07-24T00:00:00.000Z',
    parseError: null,
    ...rest,
  };
}
```

- [ ] **Step 2: Write the failing wikilink test**

Create `src/engine/wikilink.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatWikilink, parseWikilinks, resolveTarget } from './wikilink';
import { makeEntry } from './testHelpers';

describe('parseWikilinks', () => {
  const cases: [string, unknown, string[] | null][] = [
    ['single wikilink string', '[[fld-7]]', ['fld-7']],
    ['piped alias keeps the target only', '[[ana-marte|Ana]]', ['ana-marte']],
    ['multiple wikilinks in one string', '[[a]] blocks [[b]]', ['a', 'b']],
    ['array of wikilink strings', ['[[a]]', '[[b]]'], ['a', 'b']],
    ['array with piped aliases', ['[[a|A]]', '[[b|B]]'], ['a', 'b']],
    ['mixed array keeps only wikilink targets', ['[[a]]', 'plain'], ['a']],
    ['whitespace inside brackets is trimmed', '[[ flight-deck ]]', ['flight-deck']],
    ['plain string is not a wikilink', 'plain', null],
    ['number is not a wikilink', 42, null],
    ['boolean is not a wikilink', true, null],
    ['null is not a wikilink', null, null],
    ['array without wikilinks', ['x', 'y'], null],
    ['object is not a wikilink', { a: 1 }, null],
    ['empty brackets are not a wikilink', '[[]]', null],
  ];

  it.each(cases)('%s', (_name, value, expected) => {
    expect(parseWikilinks(value)).toEqual(expected);
  });
});

describe('formatWikilink', () => {
  it('wraps the target in double brackets', () => {
    expect(formatWikilink('fld-7')).toBe('[[fld-7]]');
  });
});

describe('resolveTarget', () => {
  const ana = makeEntry({
    path: 'people/ana-marte.md',
    filename: 'ana-marte.md',
    title: 'Ana Marte',
  });
  const deck = makeEntry({
    path: 'projects/flight-deck.md',
    filename: 'flight-deck.md',
    title: 'Flight deck',
  });
  // decoy: its *title* collides with deck's filename stem — stem match must win
  const decoy = makeEntry({
    path: 'items/misc.md',
    filename: 'misc.md',
    title: 'flight-deck',
  });
  const entries = [decoy, ana, deck];

  it('matches by filename stem, case-insensitive', () => {
    expect(resolveTarget('Flight-Deck', entries)).toBe(deck);
  });

  it('prefers a stem match over a title match regardless of array order', () => {
    expect(resolveTarget('flight-deck', entries)).toBe(deck);
  });

  it('falls back to exact title match, case-insensitive', () => {
    expect(resolveTarget('ana marte', entries)).toBe(ana);
  });

  it('trims the target before matching', () => {
    expect(resolveTarget('  ana-marte  ', entries)).toBe(ana);
  });

  it('returns null when nothing matches', () => {
    expect(resolveTarget('nobody', entries)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/engine/wikilink.test.ts`
Expected: FAIL — Vitest cannot resolve import `./wikilink` (module not yet created).

- [ ] **Step 4: Write the wikilink implementation**

Create `src/engine/wikilink.ts`:

```ts
import type { Entry } from './types';

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function extractTargets(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    const target = match[1].split('|')[0].trim();
    if (target.length > 0) out.push(target);
  }
  return out;
}

/** Returns wikilink targets found in a frontmatter value, or null if it contains none. */
export function parseWikilinks(value: unknown): string[] | null {
  if (typeof value === 'string') {
    const targets = extractTargets(value);
    return targets.length > 0 ? targets : null;
  }
  if (Array.isArray(value)) {
    const targets: string[] = [];
    let found = false;
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const itemTargets = extractTargets(item);
      if (itemTargets.length > 0) {
        found = true;
        targets.push(...itemTargets);
      }
    }
    return found ? targets : null;
  }
  return null;
}

export function formatWikilink(target: string): string {
  return `[[${target}]]`;
}

/** Filename-stem match first, then exact title match; both case-insensitive (Tolaria rule). */
export function resolveTarget(target: string, entries: Entry[]): Entry | null {
  const needle = target.trim().toLowerCase();
  if (needle === '') return null;
  for (const entry of entries) {
    const stem = entry.filename.replace(/\.md$/i, '').toLowerCase();
    if (stem === needle) return entry;
  }
  for (const entry of entries) {
    if (entry.title.toLowerCase() === needle) return entry;
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/engine/wikilink.test.ts`
Expected: PASS (all parseWikilinks table cases, formatWikilink, resolveTarget).

- [ ] **Step 6: Write the failing normalize test**

Create `src/engine/normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeFrontmatter, normalizeValue } from './normalize';
import type { Scalar } from './types';

describe('normalizeValue', () => {
  const cases: [string, unknown, Scalar | Scalar[]][] = [
    ['trims strings', '  hello  ', 'hello'],
    ['empty string becomes null', '', null],
    ['whitespace-only string becomes null', '   ', null],
    ['numbers pass through', 42, 42],
    ['booleans pass through', true, true],
    ['null stays null', null, null],
    ['undefined becomes null', undefined, null],
    ['date-like strings stay strings', '2026-07-24', '2026-07-24'],
    ['Date instances become ISO date strings', new Date(Date.UTC(2026, 6, 24)), '2026-07-24'],
    ['arrays normalize per element', ['a ', '', 3], ['a', null, 3]],
    ['plain objects have no scalar form', { nested: true }, null],
  ];

  it.each(cases)('%s', (_name, value, expected) => {
    expect(normalizeValue(value)).toEqual(expected);
  });
});

describe('normalizeFrontmatter', () => {
  it('splits wikilink values into relationships and scalars into properties', () => {
    const result = normalizeFrontmatter({
      type: 'Work item',
      project: '[[flight-deck]]',
      blockers: ['[[a]]', '[[b|B]]'],
      status: ' doing ',
      estimate: '',
      count: 3,
      tags: ['infra ', 'sensor'],
    });
    expect(result.relationships).toEqual({
      project: ['flight-deck'],
      blockers: ['a', 'b'],
    });
    expect(result.properties).toEqual({
      status: 'doing',
      estimate: null,
      count: 3,
      tags: ['infra', 'sensor'],
    });
  });

  it('passes nested mappings through untouched for schema.ts to parse', () => {
    const statuses = [{ id: 'todo', group: 'active', color: '#3D8BE8' }];
    const fields = { status: { kind: 'status' } };
    const result = normalizeFrontmatter({ statuses, fields });
    expect(result.properties.statuses).toBe(statuses);
    expect(result.properties.fields).toBe(fields);
  });

  it('excludes the type key — Entry.type is extracted separately', () => {
    expect(normalizeFrontmatter({ type: 'Space' }).properties).toEqual({});
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/engine/normalize.test.ts`
Expected: FAIL — Vitest cannot resolve import `./normalize` (module not yet created).

- [ ] **Step 8: Write the normalize implementation**

Create `src/engine/normalize.ts`:

```ts
import type { Scalar } from './types';
import { parseWikilinks } from './wikilink';

function normalizeScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null; // plain objects and anything else have no scalar form
}

/** Normalizes a raw frontmatter value: trim, '' → null, dates stay/become ISO strings. */
export function normalizeValue(value: unknown): Scalar | Scalar[] {
  if (Array.isArray(value)) return value.map(normalizeScalar);
  return normalizeScalar(value);
}

function isPlainObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Splits a parsed frontmatter mapping into Entry.properties / Entry.relationships,
 * mirroring the Rust parser (used by mockIpc in browser mode).
 * - Wikilink-valued keys go to relationships (ADR-0010).
 * - Nested mappings (`fields`, `statuses`, ...) pass through untouched — schema.ts parses them.
 * - The `type` key is excluded; Entry.type is extracted separately.
 */
export function normalizeFrontmatter(fm: Record<string, unknown>): {
  properties: Record<string, Scalar | Scalar[]>;
  relationships: Record<string, string[]>;
} {
  const properties: Record<string, Scalar | Scalar[]> = {};
  const relationships: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (key === 'type') continue;
    const targets = parseWikilinks(value);
    if (targets !== null) {
      relationships[key] = targets;
      continue;
    }
    if (isPlainObject(value) || (Array.isArray(value) && value.some(isPlainObject))) {
      properties[key] = value as Scalar | Scalar[];
      continue;
    }
    properties[key] = normalizeValue(value);
  }
  return { properties, relationships };
}
```

- [ ] **Step 9: Run both tests to verify they pass**

Run: `pnpm vitest run src/engine/wikilink.test.ts src/engine/normalize.test.ts`
Expected: PASS (2 files, all tests green).

- [ ] **Step 10: Commit**

```sh
git add src/engine/testHelpers.ts src/engine/wikilink.ts src/engine/wikilink.test.ts src/engine/normalize.ts src/engine/normalize.test.ts
git commit -m "feat: add wikilink parsing and frontmatter normalization engine modules"
```

---

### Task 13: Engine — schema (buildSchema, DEFAULT_STATUSES, spaceForEntry, statusSetForSpace, resolveField)

**Prerequisites:** Task 12 (`wikilink.ts`, `testHelpers.ts`).

The typed-lenses core. `buildSchema(entries)` returns the `Schema` object from the shared contracts:

- **Types:** every entry with `type: 'Type'` registers a `TypeDef` keyed by the entry **title**. Its `fields` property arrives as a raw frontmatter mapping (the Rust parser stores nested mappings in `properties` as JSON values), so parsing is defensive: unknown kinds → `'text'`, options may be mappings (`{id, label?, color?, hollow?}`) or bare strings (label defaults to the humanized id, sentence case).
- **`DEFAULT_STATUSES`:** the spec's "simple" template — backlog `#A8AFC2` / todo `#3D8BE8` / in-progress `#EFB428` (group `active`), done `#34B764` (group `done`), cancelled `#A8AFC2` hollow (group `closed`).
- **`spaceForEntry`:** a Space resolves to itself; anything with its own `space` relationship (projects) resolves through it; otherwise item → `project` relationship → project's `space` relationship → Space entry. `null` when the chain breaks.
- **`statusSetForSpace`:** parses the space note's `statuses` property (array of mappings); `null` path, unknown path, or a space without statuses → `DEFAULT_STATUSES`.
- **`resolveField`:** the `ResolvedField` contract, including ghost detection (value outside the declared option/status set) and person/relation display via `resolveTarget` titles.

**Files:**
- Create: `src/engine/schema.ts`
- Test: `src/engine/schema.test.ts`

- [ ] **Step 1: Write the failing test — fixtures, DEFAULT_STATUSES, types, spaces, status sets**

Create `src/engine/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATUSES, buildSchema } from './schema';
import { makeEntry } from './testHelpers';

const typeNote = makeEntry({
  path: 'type/work-item.md',
  filename: 'work-item.md',
  title: 'Work item',
  type: 'Type',
  properties: {
    icon: 'check-square',
    color: '#3D8BE8',
    // raw frontmatter shape, exactly as the Rust parser delivers it
    fields: {
      status: { kind: 'status' },
      priority: {
        kind: 'select',
        options: [
          { id: 'urgent', color: '#DE3B4E' },
          { id: 'high', color: '#DE8F0A' },
          { id: 'medium', color: '#3D8BE8' },
          { id: 'low', color: '#A8AFC2' },
        ],
      },
      estimate: { kind: 'select', options: ['XS', 'S', 'M'] },
      assignee: { kind: 'person' },
      due: { kind: 'date' },
      blocked: { kind: 'checkbox' },
      weird: { kind: 'hologram' }, // unknown kind → text
      project: { kind: 'relation', target: 'Project' },
    },
  },
});

const space = makeEntry({
  path: 'spaces/fieldwork.md',
  filename: 'fieldwork.md',
  title: 'Fieldwork',
  type: 'Space',
  properties: {
    color: '#3D8BE8',
    statuses: [
      { id: 'triage', group: 'active', color: '#A8AFC2' },
      { id: 'doing', group: 'active', color: '#EFB428' },
      { id: 'shipped', group: 'done', color: '#34B764' },
    ],
  },
});

const bareSpace = makeEntry({
  path: 'spaces/bare.md',
  filename: 'bare.md',
  title: 'Bare',
  type: 'Space',
});

const project = makeEntry({
  path: 'projects/flight-deck.md',
  filename: 'flight-deck.md',
  title: 'Flight deck',
  type: 'Project',
  properties: { key: 'FLD' },
  relationships: { space: ['fieldwork'] },
});

const ana = makeEntry({
  path: 'people/ana-marte.md',
  filename: 'ana-marte.md',
  title: 'Ana Marte',
  type: 'Person',
});

const item = makeEntry({
  path: 'items/fld-1.md',
  filename: 'fld-1.md',
  title: 'Fix the door',
  type: 'Work item',
  properties: {
    key: 'FLD-1',
    status: 'doing',
    priority: 'high',
    due: '2026-08-01',
    blocked: true,
    notes: 'hello', // undeclared field
  },
  relationships: { project: ['flight-deck'], assignee: ['ana-marte'] },
});

const ghostItem = makeEntry({
  path: 'items/fld-2.md',
  filename: 'fld-2.md',
  title: 'Odd one',
  type: 'Work item',
  properties: { status: 'qa', priority: 'blocker' },
  relationships: { project: ['flight-deck'], assignee: ['ghost-person'] },
});

const floating = makeEntry({
  path: 'items/floating.md',
  filename: 'floating.md',
  title: 'Floating',
  type: 'Work item',
  properties: { status: 'todo' },
});

const orphan = makeEntry({
  path: 'items/orphan.md',
  filename: 'orphan.md',
  title: 'Orphan',
  type: 'Work item',
  relationships: { project: ['nowhere'] },
});

const entries = [typeNote, space, bareSpace, project, ana, item, ghostItem, floating, orphan];
const schema = buildSchema(entries);

describe('DEFAULT_STATUSES', () => {
  it('matches the spec simple template exactly', () => {
    expect(DEFAULT_STATUSES).toEqual([
      { id: 'backlog', label: 'Backlog', color: '#A8AFC2', group: 'active' },
      { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
      { id: 'in-progress', label: 'In progress', color: '#EFB428', group: 'active' },
      { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
      { id: 'cancelled', label: 'Cancelled', color: '#A8AFC2', hollow: true, group: 'closed' },
    ]);
  });
});

describe('buildSchema — types', () => {
  it('registers a TypeDef per type-note, keyed by title', () => {
    expect([...schema.types.keys()]).toEqual(['Work item']);
    const def = schema.types.get('Work item')!;
    expect(def.name).toBe('Work item');
    expect(def.icon).toBe('check-square');
    expect(def.color).toBe('#3D8BE8');
    expect(def.fields.map((f) => f.name)).toEqual([
      'status', 'priority', 'estimate', 'assignee', 'due', 'blocked', 'weird', 'project',
    ]);
  });

  it('parses mapping options with humanized labels and colors', () => {
    const priority = schema.types.get('Work item')!.fields.find((f) => f.name === 'priority')!;
    expect(priority.kind).toBe('select');
    expect(priority.options![1]).toEqual({ id: 'high', label: 'High', color: '#DE8F0A' });
  });

  it('parses bare-string options', () => {
    const estimate = schema.types.get('Work item')!.fields.find((f) => f.name === 'estimate')!;
    expect(estimate.options).toEqual([
      { id: 'XS', label: 'XS', color: null },
      { id: 'S', label: 'S', color: null },
      { id: 'M', label: 'M', color: null },
    ]);
  });

  it('falls back unknown kinds to text', () => {
    const weird = schema.types.get('Work item')!.fields.find((f) => f.name === 'weird')!;
    expect(weird).toEqual({ name: 'weird', kind: 'text' });
  });

  it('keeps relation targets', () => {
    const rel = schema.types.get('Work item')!.fields.find((f) => f.name === 'project')!;
    expect(rel).toEqual({ name: 'project', kind: 'relation', target: 'Project' });
  });

  it('tolerates a fields value that is not a mapping', () => {
    const broken = makeEntry({
      path: 'type/broken.md',
      filename: 'broken.md',
      title: 'Broken',
      type: 'Type',
      properties: { fields: 'oops' },
    });
    expect(buildSchema([broken]).types.get('Broken')!.fields).toEqual([]);
  });
});

describe('spaceForEntry', () => {
  it('resolves item → project → space', () => {
    expect(schema.spaceForEntry(item)).toBe(space);
  });

  it('resolves a project via its own space relationship', () => {
    expect(schema.spaceForEntry(project)).toBe(space);
  });

  it('a space resolves to itself', () => {
    expect(schema.spaceForEntry(space)).toBe(space);
  });

  it('returns null when the entry has no project relationship', () => {
    expect(schema.spaceForEntry(floating)).toBeNull();
  });

  it('returns null when the project target does not resolve', () => {
    expect(schema.spaceForEntry(orphan)).toBeNull();
  });
});

describe('statusSetForSpace', () => {
  it('null path falls back to DEFAULT_STATUSES', () => {
    expect(schema.statusSetForSpace(null)).toBe(DEFAULT_STATUSES);
  });

  it('parses the statuses property with humanized labels', () => {
    expect(schema.statusSetForSpace('spaces/fieldwork.md')).toEqual([
      { id: 'triage', label: 'Triage', color: '#A8AFC2', group: 'active' },
      { id: 'doing', label: 'Doing', color: '#EFB428', group: 'active' },
      { id: 'shipped', label: 'Shipped', color: '#34B764', group: 'done' },
    ]);
  });

  it('a space without a statuses property falls back to DEFAULT_STATUSES', () => {
    expect(schema.statusSetForSpace('spaces/bare.md')).toBe(DEFAULT_STATUSES);
  });

  it('an unknown path falls back to DEFAULT_STATUSES', () => {
    expect(schema.statusSetForSpace('spaces/nope.md')).toBe(DEFAULT_STATUSES);
  });
});
```

- [ ] **Step 2: Append the failing resolveField tests**

Append to the end of `src/engine/schema.test.ts`:

```ts
describe('resolveField', () => {
  it('status resolves against the status set of the item space', () => {
    expect(schema.resolveField(item, 'status')).toEqual({
      def: { name: 'status', kind: 'status' },
      raw: 'doing',
      display: 'Doing',
      color: '#EFB428',
      ghost: false,
    });
  });

  it('an unknown status value is a ghost with its raw id as display', () => {
    const resolved = schema.resolveField(ghostItem, 'status');
    expect(resolved.display).toBe('qa');
    expect(resolved.ghost).toBe(true);
    expect(resolved.color).toBeNull();
  });

  it('status falls back to DEFAULT_STATUSES when the item has no space', () => {
    const resolved = schema.resolveField(floating, 'status');
    expect(resolved.display).toBe('Todo');
    expect(resolved.color).toBe('#3D8BE8');
    expect(resolved.ghost).toBe(false);
  });

  it('select resolves label and color from the options list', () => {
    const resolved = schema.resolveField(item, 'priority');
    expect(resolved.display).toBe('High');
    expect(resolved.color).toBe('#DE8F0A');
    expect(resolved.ghost).toBe(false);
  });

  it('a select value outside the options list is a ghost', () => {
    const resolved = schema.resolveField(ghostItem, 'priority');
    expect(resolved.display).toBe('blocker');
    expect(resolved.ghost).toBe(true);
    expect(resolved.color).toBeNull();
  });

  it('person displays the resolved entry title', () => {
    const resolved = schema.resolveField(item, 'assignee');
    expect(resolved.display).toBe('Ana Marte');
    expect(resolved.ghost).toBe(false);
  });

  it('an unresolved person target falls back to the raw target', () => {
    expect(schema.resolveField(ghostItem, 'assignee').display).toBe('ghost-person');
  });

  it('relation displays the resolved entry title', () => {
    expect(schema.resolveField(item, 'project').display).toBe('Flight deck');
  });

  it('date values pass through as strings', () => {
    expect(schema.resolveField(item, 'due').display).toBe('2026-08-01');
  });

  it('checkbox true displays as Yes', () => {
    expect(schema.resolveField(item, 'blocked').display).toBe('Yes');
  });

  it('undeclared fields resolve with a null def but still display (advisory)', () => {
    const resolved = schema.resolveField(item, 'notes');
    expect(resolved.def).toBeNull();
    expect(resolved.display).toBe('hello');
    expect(resolved.ghost).toBe(false);
  });

  it('declared-but-missing fields resolve empty with the def attached', () => {
    const resolved = schema.resolveField(item, 'estimate');
    expect(resolved.def).toEqual({
      name: 'estimate',
      kind: 'select',
      options: [
        { id: 'XS', label: 'XS', color: null },
        { id: 'S', label: 'S', color: null },
        { id: 'M', label: 'M', color: null },
      ],
    });
    expect(resolved.display).toBe('');
    expect(resolved.ghost).toBe(false);
  });

  it('a missing undeclared field resolves fully empty', () => {
    expect(schema.resolveField(item, 'nonexistent')).toEqual({
      def: null,
      raw: undefined,
      display: '',
      color: null,
      ghost: false,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/engine/schema.test.ts`
Expected: FAIL — Vitest cannot resolve import `./schema` (module not yet created).

- [ ] **Step 4: Write the schema implementation**

Create `src/engine/schema.ts`:

```ts
import type {
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  ResolvedField,
  Schema,
  StatusDef,
  TypeDef,
} from './types';
import { resolveTarget } from './wikilink';

/** Spec "simple" status template — fallback when an item has no resolvable space. */
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'backlog', label: 'Backlog', color: '#A8AFC2', group: 'active' },
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'in-progress', label: 'In progress', color: '#EFB428', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
  { id: 'cancelled', label: 'Cancelled', color: '#A8AFC2', hollow: true, group: 'closed' },
];

const FIELD_KINDS: FieldKind[] = [
  'text', 'number', 'checkbox', 'date', 'daterange',
  'select', 'multiselect', 'status', 'person', 'relation',
];

const STATUS_GROUPS = ['active', 'done', 'closed'] as const;

/** 'in-progress' → 'In progress' (sentence case, DS rule). */
function humanize(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  if (words === '') return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function asFieldKind(value: unknown): FieldKind {
  return FIELD_KINDS.includes(value as FieldKind) ? (value as FieldKind) : 'text';
}

function parseOption(raw: unknown): FieldOption | null {
  if (typeof raw === 'string') {
    return { id: raw, label: humanize(raw), color: null };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' && typeof o.id !== 'number') return null;
  const id = String(o.id);
  const option: FieldOption = {
    id,
    label: typeof o.label === 'string' ? o.label : humanize(id),
    color: typeof o.color === 'string' ? o.color : null,
  };
  if (o.hollow === true) option.hollow = true;
  return option;
}

function parseFieldDef(name: string, spec: unknown): FieldDef {
  if (typeof spec === 'string') return { name, kind: asFieldKind(spec) };
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { name, kind: 'text' };
  }
  const s = spec as Record<string, unknown>;
  const def: FieldDef = { name, kind: asFieldKind(s.kind) };
  if (Array.isArray(s.options)) {
    def.options = s.options
      .map(parseOption)
      .filter((o): o is FieldOption => o !== null);
  }
  if (typeof s.target === 'string') def.target = s.target;
  return def;
}

function parseFields(raw: unknown): FieldDef[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, spec]) =>
    parseFieldDef(name, spec),
  );
}

function parseStatuses(raw: unknown): StatusDef[] {
  if (!Array.isArray(raw)) return [];
  const out: StatusDef[] = [];
  for (const item of raw) {
    const option = parseOption(item);
    if (option === null) continue;
    const groupRaw =
      item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>).group
        : undefined;
    const group: StatusDef['group'] =
      typeof groupRaw === 'string' && (STATUS_GROUPS as readonly string[]).includes(groupRaw)
        ? (groupRaw as StatusDef['group'])
        : 'active';
    out.push({ ...option, group });
  }
  return out;
}

function isEmptyValue(raw: unknown): boolean {
  return (
    raw === undefined ||
    raw === null ||
    raw === '' ||
    (Array.isArray(raw) && raw.length === 0)
  );
}

export function buildSchema(entries: Entry[]): Schema {
  const types = new Map<string, TypeDef>();
  for (const e of entries) {
    if (e.type !== 'Type') continue;
    types.set(e.title, {
      name: e.title,
      icon: typeof e.properties.icon === 'string' ? e.properties.icon : null,
      color: typeof e.properties.color === 'string' ? e.properties.color : null,
      fields: parseFields((e.properties as Record<string, unknown>).fields),
    });
  }

  const byPath = new Map(entries.map((e) => [e.path, e]));

  function firstTarget(e: Entry, key: string): string | null {
    const targets = e.relationships[key];
    return targets !== undefined && targets.length > 0 ? targets[0] : null;
  }

  function spaceForEntry(e: Entry): Entry | null {
    if (e.type === 'Space') return e;
    const ownSpace = firstTarget(e, 'space');
    if (ownSpace !== null) {
      const found = resolveTarget(ownSpace, entries);
      return found !== null && found.type === 'Space' ? found : null;
    }
    const projectTarget = firstTarget(e, 'project');
    if (projectTarget === null) return null;
    const project = resolveTarget(projectTarget, entries);
    if (project === null) return null;
    const spaceTarget = firstTarget(project, 'space');
    if (spaceTarget === null) return null;
    const found = resolveTarget(spaceTarget, entries);
    return found !== null && found.type === 'Space' ? found : null;
  }

  function statusSetForSpace(spacePath: string | null): StatusDef[] {
    if (spacePath === null) return DEFAULT_STATUSES;
    const space = byPath.get(spacePath);
    if (space === undefined) return DEFAULT_STATUSES;
    const parsed = parseStatuses((space.properties as Record<string, unknown>).statuses);
    return parsed.length > 0 ? parsed : DEFAULT_STATUSES;
  }

  function resolveField(e: Entry, field: string): ResolvedField {
    const typeDef = e.type !== null ? types.get(e.type) : undefined;
    const def = typeDef?.fields.find((f) => f.name === field) ?? null;
    const relTargets = e.relationships[field];
    const raw: unknown = relTargets !== undefined ? relTargets : e.properties[field];

    if (isEmptyValue(raw)) {
      return { def, raw, display: '', color: null, ghost: false };
    }

    const kind: FieldKind = def?.kind ?? (relTargets !== undefined ? 'relation' : 'text');

    if (kind === 'person' || kind === 'relation') {
      const targets = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const display = targets
        .map((t) => resolveTarget(t, entries)?.title ?? t)
        .join(', ');
      return { def, raw, display, color: null, ghost: false };
    }

    if (kind === 'status') {
      const space = spaceForEntry(e);
      const statuses = statusSetForSpace(space !== null ? space.path : null);
      const id = String(Array.isArray(raw) ? raw[0] : raw);
      const match = statuses.find((s) => s.id === id);
      if (match !== undefined) {
        return { def, raw, display: match.label, color: match.color, ghost: false };
      }
      return { def, raw, display: id, color: null, ghost: true };
    }

    if (kind === 'select' || kind === 'multiselect') {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const options = def?.options ?? [];
      let ghost = false;
      let color: string | null = null;
      const labels = values.map((v) => {
        const match = options.find((o) => o.id === v);
        if (match === undefined) {
          ghost = true;
          return v; // ghost values keep their raw form (advisory schema)
        }
        if (color === null) color = match.color;
        return match.label;
      });
      return { def, raw, display: labels.join(', '), color, ghost };
    }

    if (kind === 'checkbox') {
      return { def, raw, display: raw === true ? 'Yes' : 'No', color: null, ghost: false };
    }

    // text / number / date / daterange and undeclared fields
    const display = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
    return { def, raw, display, color: null, ghost: false };
  }

  return { types, spaceForEntry, statusSetForSpace, resolveField };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/engine/schema.test.ts`
Expected: PASS (all describe blocks: DEFAULT_STATUSES, types, spaceForEntry, statusSetForSpace, resolveField).

- [ ] **Step 6: Commit**

```sh
git add src/engine/schema.ts src/engine/schema.test.ts
git commit -m "feat: add schema engine with type parsing, space status sets, and field resolution"
```

---

### Task 14: Engine — grouping (shared by List and Board)

**Prerequisites:** Task 13 (`schema.ts`).

`groupEntries(entries, field, schema)` partitions entries into ordered `Group[]`:

- **Order:** for `status` fields, the status set of the first entry's space (all known statuses appear, empty ones included — the Board needs empty columns); for `select` fields, the declared option order (empty options included); for `person`/`relation`, alphabetical by resolved display name; for plain/undeclared fields, alphabetical by value.
- **Ghosts:** values outside a declared option/status set become trailing ghost groups (first-seen order, `ghost: true`, muted rendering downstream).
- **Ungrouped:** entries with an empty value go to a trailing `No <field>` group (key `__none__`), only when non-empty.
- **Stability:** entry order inside each group preserves the caller's input order — the collections layer sorts before grouping; `groupEntries` never re-sorts entries.

**Files:**
- Create: `src/engine/grouping.ts`
- Test: `src/engine/grouping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/grouping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSchema } from './schema';
import { groupEntries } from './grouping';
import { makeEntry } from './testHelpers';

const typeNote = makeEntry({
  path: 'type/work-item.md',
  filename: 'work-item.md',
  title: 'Work item',
  type: 'Type',
  properties: {
    fields: {
      status: { kind: 'status' },
      priority: {
        kind: 'select',
        options: [
          { id: 'urgent', color: '#DE3B4E' },
          { id: 'high', color: '#DE8F0A' },
          { id: 'low', color: '#A8AFC2' },
        ],
      },
      assignee: { kind: 'person' },
    },
  },
});

const space = makeEntry({
  path: 'spaces/fieldwork.md',
  filename: 'fieldwork.md',
  title: 'Fieldwork',
  type: 'Space',
  properties: {
    statuses: [
      { id: 'triage', group: 'active', color: '#A8AFC2' },
      { id: 'doing', group: 'active', color: '#EFB428' },
      { id: 'shipped', group: 'done', color: '#34B764' },
    ],
  },
});

const project = makeEntry({
  path: 'projects/flight-deck.md',
  filename: 'flight-deck.md',
  title: 'Flight deck',
  type: 'Project',
  relationships: { space: ['fieldwork'] },
});

const ana = makeEntry({
  path: 'people/ana-marte.md',
  filename: 'ana-marte.md',
  title: 'Ana Marte',
  type: 'Person',
});

const zed = makeEntry({
  path: 'people/zed-quill.md',
  filename: 'zed-quill.md',
  title: 'Zed Quill',
  type: 'Person',
});

const i1 = makeEntry({
  path: 'items/i1.md', filename: 'i1.md', title: 'One', type: 'Work item',
  properties: { status: 'doing', priority: 'high' },
  relationships: { project: ['flight-deck'], assignee: ['ana-marte'] },
});
const i2 = makeEntry({
  path: 'items/i2.md', filename: 'i2.md', title: 'Two', type: 'Work item',
  properties: { status: 'doing', priority: 'low' },
  relationships: { project: ['flight-deck'], assignee: ['zed-quill'] },
});
const i3 = makeEntry({
  path: 'items/i3.md', filename: 'i3.md', title: 'Three', type: 'Work item',
  properties: { status: 'shipped' },
  relationships: { project: ['flight-deck'], assignee: ['ghost-user'] },
});
const i4 = makeEntry({
  path: 'items/i4.md', filename: 'i4.md', title: 'Four', type: 'Work item',
  properties: { status: 'qa' }, // ghost status
  relationships: { project: ['flight-deck'] },
});
const i5 = makeEntry({
  path: 'items/i5.md', filename: 'i5.md', title: 'Five', type: 'Work item',
  relationships: { project: ['flight-deck'] },
});

// person entries are in the schema entry set but NOT in the grouped subset,
// exactly like a project page grouping its work items
const schema = buildSchema([typeNote, space, project, ana, zed, i1, i2, i3, i4, i5]);
const items = [i1, i2, i3, i4, i5];

describe('groupEntries — status', () => {
  it('orders groups by the space status set, keeps empty groups, ghosts unknown values, trails No status', () => {
    const groups = groupEntries(items, 'status', schema);
    expect(groups.map((g) => g.key)).toEqual(['triage', 'doing', 'shipped', 'qa', '__none__']);
    expect(groups.map((g) => g.label)).toEqual(['Triage', 'Doing', 'Shipped', 'qa', 'No status']);
    expect(groups.map((g) => g.ghost)).toEqual([false, false, false, true, false]);
    expect(groups[0].entries).toEqual([]); // empty known group kept for board columns
    expect(groups[1].entries).toEqual([i1, i2]);
    expect(groups[1].color).toBe('#EFB428');
    expect(groups[2].entries).toEqual([i3]);
    expect(groups[3].entries).toEqual([i4]);
    expect(groups[3].color).toBeNull();
    expect(groups[4].entries).toEqual([i5]);
  });

  it('keeps the caller-provided order within groups (caller sorts first)', () => {
    const groups = groupEntries([i2, i1, i3, i4, i5], 'status', schema);
    expect(groups.find((g) => g.key === 'doing')!.entries).toEqual([i2, i1]);
  });

  it('returns an empty array for an empty entry list', () => {
    expect(groupEntries([], 'status', schema)).toEqual([]);
  });
});

describe('groupEntries — select', () => {
  it('orders groups by the declared option list with colors', () => {
    const groups = groupEntries(items, 'priority', schema);
    expect(groups.map((g) => g.key)).toEqual(['urgent', 'high', 'low', '__none__']);
    expect(groups.map((g) => g.label)).toEqual(['Urgent', 'High', 'Low', 'No priority']);
    expect(groups.find((g) => g.key === 'high')!.entries).toEqual([i1]);
    expect(groups.find((g) => g.key === 'high')!.color).toBe('#DE8F0A');
    expect(groups.find((g) => g.key === 'urgent')!.entries).toEqual([]);
    expect(groups[3].entries).toEqual([i3, i4, i5]);
  });
});

describe('groupEntries — person', () => {
  it('orders groups alphabetically by resolved display name, unresolved targets keep raw form', () => {
    const groups = groupEntries(items, 'assignee', schema);
    expect(groups.map((g) => g.label)).toEqual(['Ana Marte', 'ghost-user', 'Zed Quill', 'No assignee']);
    expect(groups.map((g) => g.key)).toEqual(['ana-marte', 'ghost-user', 'zed-quill', '__none__']);
    expect(groups[0].entries).toEqual([i1]);
    expect(groups[3].entries).toEqual([i4, i5]);
    expect(groups.every((g) => g.ghost === false)).toBe(true);
  });
});

describe('groupEntries — plain values', () => {
  it('groups undeclared text fields alphabetically by value', () => {
    const a = makeEntry({ path: 'items/a.md', filename: 'a.md', properties: { phase: 'beta' } });
    const b = makeEntry({ path: 'items/b.md', filename: 'b.md', properties: { phase: 'alpha' } });
    const c = makeEntry({ path: 'items/c.md', filename: 'c.md' });
    const groups = groupEntries([a, b, c], 'phase', buildSchema([a, b, c]));
    expect(groups.map((g) => g.key)).toEqual(['alpha', 'beta', '__none__']);
    expect(groups[2].label).toBe('No phase');
    expect(groups[0].entries).toEqual([b]);
  });

  it('a field nobody has yields a single No <field> group', () => {
    const groups = groupEntries(items, 'zzz', schema);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '__none__', label: 'No zzz', ghost: false });
    expect(groups[0].entries).toEqual(items);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/grouping.test.ts`
Expected: FAIL — Vitest cannot resolve import `./grouping` (module not yet created).

- [ ] **Step 3: Write the grouping implementation**

Create `src/engine/grouping.ts`:

```ts
import type { Entry, FieldDef, FieldKind, FieldOption, Group, Schema } from './types';

function firstValue(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : null;
  return String(raw);
}

/**
 * Shared grouping engine for List and Board.
 * - Known option/status groups appear in declared order, empty ones included.
 * - Values outside the declared set become trailing ghost groups (first-seen order).
 * - Entries with no value go to a trailing "No <field>" group.
 * - Entry order within groups preserves the caller's input order (caller sorts first).
 */
export function groupEntries(entries: Entry[], field: string, schema: Schema): Group[] {
  let def: FieldDef | null = null;
  for (const e of entries) {
    const found = schema.resolveField(e, field).def;
    if (found !== null) {
      def = found;
      break;
    }
  }
  const kind: FieldKind = def?.kind ?? 'text';

  let known: FieldOption[] = [];
  if (kind === 'status') {
    const space = entries.length > 0 ? schema.spaceForEntry(entries[0]) : null;
    known = schema.statusSetForSpace(space !== null ? space.path : null);
  } else if (def?.options !== undefined && def.options.length > 0) {
    known = def.options;
  }

  // Map preserves insertion order → ghost groups keep first-seen order.
  const buckets = new Map<string, Entry[]>();
  const ungrouped: Entry[] = [];
  for (const e of entries) {
    const raw =
      e.relationships[field] !== undefined ? e.relationships[field] : e.properties[field];
    const key = firstValue(raw);
    if (key === null) {
      ungrouped.push(e);
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [e]);
    else bucket.push(e);
  }

  const groups: Group[] = [];

  if (known.length > 0) {
    for (const option of known) {
      groups.push({
        key: option.id,
        label: option.label,
        color: option.color,
        ghost: false,
        entries: buckets.get(option.id) ?? [],
      });
      buckets.delete(option.id);
    }
    for (const [key, bucket] of buckets) {
      groups.push({ key, label: key, color: null, ghost: true, entries: bucket });
    }
  } else if (kind === 'person' || kind === 'relation') {
    const labelled = [...buckets.entries()].map(([key, bucket]) => ({
      key,
      bucket,
      // resolveField display for the bucket's first entry starts with this key's
      // resolved title (key = first target by construction)
      label: schema.resolveField(bucket[0], field).display.split(', ')[0] || key,
    }));
    labelled.sort((a, b) => a.label.localeCompare(b.label));
    for (const g of labelled) {
      groups.push({ key: g.key, label: g.label, color: null, ghost: false, entries: g.bucket });
    }
  } else {
    const keys = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      groups.push({ key, label: key, color: null, ghost: false, entries: buckets.get(key)! });
    }
  }

  if (ungrouped.length > 0) {
    groups.push({
      key: '__none__',
      label: `No ${field}`,
      color: null,
      ghost: false,
      entries: ungrouped,
    });
  }

  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/engine/grouping.test.ts`
Expected: PASS (status, select, person, plain-value describe blocks all green).

- [ ] **Step 5: Commit**

```sh
git add src/engine/grouping.ts src/engine/grouping.test.ts
git commit -m "feat: add shared grouping engine for list and board views"
```

---

### Task 15: Engine — saved views (views.ts) and filter evaluation (viewFilters.ts)

**Prerequisites:** Task 13 (`schema.ts` — filter tests build a schema), `yaml` ^2.8 (installed in Task 1).

Two modules:

- `views.ts` — `parseViewYaml(id, yaml)` is tolerant: bad YAML or a non-mapping document yields `{name: id, presentation: <default list>}`; missing presentation fields fall back per-field to the project default (list, grouped by `status`, ordered by `modifiedAt` desc, visible fields `key, status, priority, assignee, due, estimate`); malformed filter nodes are dropped, a malformed filter tree becomes `null`. `serializeView(def)` writes YAML that round-trips through `parseViewYaml`.
- `viewFilters.ts` — `evaluateFilters(entry, group, schema)` evaluates the recursive `{all|any}` tree. Field lookup checks `relationships` first, then `properties`, with `type`/`title` falling back to the Entry fields (saved views filter on `type` routinely). Op semantics: `equals` = scalar equality or array membership; `contains` = case-insensitive substring (any element for arrays); `any_of`/`none_of` = set intersection; `before`/`after` = strict ISO date string compare; `is_empty` covers missing key, `null`, `''`, and empty array.

**Files:**
- Create: `src/engine/views.ts`
- Create: `src/engine/viewFilters.ts`
- Test: `src/engine/views.test.ts`
- Test: `src/engine/viewFilters.test.ts`

- [ ] **Step 1: Write the failing views test**

Create `src/engine/views.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseViewYaml, serializeView } from './views';
import type { ViewDefinition } from './types';

const DEFAULT_LIST_PRESENTATION = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
};

const ACTIVE_WORK_YAML = `name: Active work
icon: flame
color: '#DE8F0A'
order: 2
filters:
  all:
    - { field: type, op: equals, value: Work item }
    - any:
        - { field: status, op: any_of, value: [todo, doing] }
        - { field: priority, op: equals, value: urgent }
presentation:
  type: board
  groupBy: status
  orderBy: { field: due, dir: asc }
  visibleFields: [key, status, assignee]
`;

describe('parseViewYaml', () => {
  it('parses a complete view file', () => {
    expect(parseViewYaml('active-work', ACTIVE_WORK_YAML)).toEqual({
      id: 'active-work',
      definition: {
        name: 'Active work',
        icon: 'flame',
        color: '#DE8F0A',
        order: 2,
        filters: {
          all: [
            { field: 'type', op: 'equals', value: 'Work item' },
            {
              any: [
                { field: 'status', op: 'any_of', value: ['todo', 'doing'] },
                { field: 'priority', op: 'equals', value: 'urgent' },
              ],
            },
          ],
        },
        presentation: {
          type: 'board',
          groupBy: 'status',
          orderBy: { field: 'due', dir: 'asc' },
          visibleFields: ['key', 'status', 'assignee'],
        },
      },
    });
  });

  it('bad yaml falls back to name = id and the default list presentation', () => {
    const view = parseViewYaml('mystery', 'a: [1, 2');
    expect(view.definition).toEqual({
      name: 'mystery',
      icon: null,
      color: null,
      order: null,
      filters: null,
      presentation: DEFAULT_LIST_PRESENTATION,
    });
  });

  it('a scalar yaml document gets full defaults', () => {
    const view = parseViewYaml('plain', 'just some text');
    expect(view.definition.name).toBe('plain');
    expect(view.definition.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('an empty file gets full defaults', () => {
    expect(parseViewYaml('empty', '').definition.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('missing presentation fields fall back individually', () => {
    const view = parseViewYaml('partial', 'name: Partial\npresentation:\n  type: board\n');
    expect(view.definition.presentation).toEqual({
      type: 'board',
      groupBy: 'status',
      orderBy: { field: 'modifiedAt', dir: 'desc' },
      visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
    });
  });

  it('an explicit groupBy null stays null (flat list)', () => {
    const view = parseViewYaml('flat', 'presentation:\n  groupBy: null\n');
    expect(view.definition.presentation.groupBy).toBeNull();
  });

  it('drops malformed filter rules but keeps valid ones', () => {
    const view = parseViewYaml(
      'broken',
      'filters:\n  all:\n    - { field: status }\n    - { field: status, op: equals, value: done }\n',
    );
    expect(view.definition.filters).toEqual({
      all: [{ field: 'status', op: 'equals', value: 'done' }],
    });
  });

  it('a filters value that is not a group becomes null', () => {
    expect(parseViewYaml('junk', 'filters: nonsense').definition.filters).toBeNull();
  });
});

describe('serializeView', () => {
  it('round-trips through parseViewYaml', () => {
    const def: ViewDefinition = {
      name: 'Sprint board',
      icon: null,
      color: null,
      order: 3,
      filters: {
        any: [
          { field: 'status', op: 'is_empty' },
          {
            all: [
              { field: 'priority', op: 'none_of', value: ['low'] },
              { field: 'due', op: 'before', value: '2026-09-01' },
            ],
          },
        ],
      },
      presentation: {
        type: 'board',
        groupBy: null,
        orderBy: { field: 'title', dir: 'asc' },
        visibleFields: ['key', 'status'],
      },
    };
    expect(parseViewYaml('sprint-board', serializeView(def)).definition).toEqual(def);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/views.test.ts`
Expected: FAIL — Vitest cannot resolve import `./views` (module not yet created).

- [ ] **Step 3: Write the views implementation**

Create `src/engine/views.ts`:

```ts
import { parse, stringify } from 'yaml';
import type {
  FilterGroup,
  FilterOp,
  FilterRule,
  Presentation,
  Scalar,
  ViewDefinition,
  ViewFile,
} from './types';

/** Project default: list grouped by status, modified desc (spec "Collections and views"). */
export const DEFAULT_PRESENTATION: Presentation = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
};

const FILTER_OPS: FilterOp[] = [
  'equals', 'not_equals', 'contains', 'any_of', 'none_of',
  'is_empty', 'is_not_empty', 'before', 'after',
];

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function parsePresentation(raw: unknown): Presentation {
  const obj = asRecord(raw);
  const orderBy = asRecord(obj.orderBy);
  return {
    type: obj.type === 'board' ? 'board' : 'list',
    groupBy:
      typeof obj.groupBy === 'string'
        ? obj.groupBy
        : obj.groupBy === null
          ? null
          : DEFAULT_PRESENTATION.groupBy,
    orderBy: {
      field:
        typeof orderBy.field === 'string' ? orderBy.field : DEFAULT_PRESENTATION.orderBy.field,
      dir: orderBy.dir === 'asc' ? 'asc' : 'desc',
    },
    visibleFields: Array.isArray(obj.visibleFields)
      ? obj.visibleFields.map(String)
      : [...DEFAULT_PRESENTATION.visibleFields],
  };
}

function parseFilterNode(raw: unknown): FilterRule | FilterGroup | null {
  const obj = asRecord(raw);
  if (Array.isArray(obj.all) || Array.isArray(obj.any)) return parseFilters(raw);
  if (typeof obj.field === 'string' && FILTER_OPS.includes(obj.op as FilterOp)) {
    const rule: FilterRule = { field: obj.field, op: obj.op as FilterOp };
    if (obj.value !== undefined) rule.value = obj.value as Scalar | Scalar[];
    return rule;
  }
  return null;
}

export function parseFilters(raw: unknown): FilterGroup | null {
  const obj = asRecord(raw);
  const branch = Array.isArray(obj.all) ? 'all' : Array.isArray(obj.any) ? 'any' : null;
  if (branch === null) return null;
  const children = (obj[branch] as unknown[])
    .map(parseFilterNode)
    .filter((node): node is FilterRule | FilterGroup => node !== null);
  return branch === 'all' ? { all: children } : { any: children };
}

/** Tolerant by design: a saved view file never fails to load (advisory schema rule). */
export function parseViewYaml(id: string, yamlText: string): ViewFile {
  let raw: unknown = null;
  try {
    raw = parse(yamlText);
  } catch {
    raw = null;
  }
  const obj = asRecord(raw);
  return {
    id,
    definition: {
      name: typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name : id,
      icon: typeof obj.icon === 'string' ? obj.icon : null,
      color: typeof obj.color === 'string' ? obj.color : null,
      order: typeof obj.order === 'number' ? obj.order : null,
      filters: parseFilters(obj.filters),
      presentation: parsePresentation(obj.presentation),
    },
  };
}

export function serializeView(def: ViewDefinition): string {
  return stringify({
    name: def.name,
    icon: def.icon,
    color: def.color,
    order: def.order,
    filters: def.filters,
    presentation: def.presentation,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/engine/views.test.ts`
Expected: PASS (parse, tolerance, and round-trip tests green).

- [ ] **Step 5: Write the failing viewFilters test**

Create `src/engine/viewFilters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateFilters } from './viewFilters';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { FilterGroup, FilterRule } from './types';

const entry = makeEntry({
  path: 'items/fld-2.md',
  filename: 'fld-2.md',
  title: 'Calibrate sensors',
  type: 'Work item',
  properties: {
    status: 'doing',
    priority: 'high',
    due: '2026-08-01',
    estimate: '',
    parent: null,
    tags: ['infra', 'sensor'],
    watchers: [],
  },
  relationships: { assignee: ['ana-marte'], project: ['flight-deck'] },
});

const schema = buildSchema([entry]);

const wrap = (rule: FilterRule): FilterGroup => ({ all: [rule] });

describe('evaluateFilters — single ops', () => {
  const cases: [string, FilterRule, boolean][] = [
    ['equals matches a scalar property', { field: 'status', op: 'equals', value: 'doing' }, true],
    ['equals rejects a different scalar', { field: 'status', op: 'equals', value: 'done' }, false],
    ['equals matches membership in a relationship array', { field: 'assignee', op: 'equals', value: 'ana-marte' }, true],
    ['equals matches membership in an array property', { field: 'tags', op: 'equals', value: 'infra' }, true],
    ['equals matches the entry type', { field: 'type', op: 'equals', value: 'Work item' }, true],
    ['not_equals passes for a different value', { field: 'status', op: 'not_equals', value: 'done' }, true],
    ['not_equals rejects the matching value', { field: 'status', op: 'not_equals', value: 'doing' }, false],
    ['contains is a case-insensitive substring', { field: 'title', op: 'contains', value: 'SENS' }, true],
    ['contains checks each array element', { field: 'tags', op: 'contains', value: 'ensor' }, true],
    ['contains rejects a non-substring', { field: 'title', op: 'contains', value: 'zzz' }, false],
    ['any_of matches when the value is in the set', { field: 'status', op: 'any_of', value: ['todo', 'doing'] }, true],
    ['any_of rejects when the value is not in the set', { field: 'status', op: 'any_of', value: ['todo', 'done'] }, false],
    ['any_of intersects array values', { field: 'tags', op: 'any_of', value: ['sensor'] }, true],
    ['none_of rejects an intersection', { field: 'assignee', op: 'none_of', value: ['ana-marte'] }, false],
    ['none_of passes with no intersection', { field: 'status', op: 'none_of', value: ['done', 'cancelled'] }, true],
    ['none_of passes on a missing field', { field: 'owner', op: 'none_of', value: ['ana-marte'] }, true],
    ['before uses strict ISO string compare', { field: 'due', op: 'before', value: '2026-09-01' }, true],
    ['before rejects the same date', { field: 'due', op: 'before', value: '2026-08-01' }, false],
    ['before rejects a missing field', { field: 'owner', op: 'before', value: '2026-09-01' }, false],
    ['after passes for an earlier bound', { field: 'due', op: 'after', value: '2026-07-01' }, true],
    ['after rejects the same date', { field: 'due', op: 'after', value: '2026-08-01' }, false],
    ['is_empty on an empty string', { field: 'estimate', op: 'is_empty' }, true],
    ['is_empty on a null value', { field: 'parent', op: 'is_empty' }, true],
    ['is_empty on a missing key', { field: 'owner', op: 'is_empty' }, true],
    ['is_empty on an empty array', { field: 'watchers', op: 'is_empty' }, true],
    ['is_empty rejects a present value', { field: 'status', op: 'is_empty' }, false],
    ['is_not_empty on a present value', { field: 'status', op: 'is_not_empty' }, true],
    ['is_not_empty on a relationship', { field: 'assignee', op: 'is_not_empty' }, true],
    ['is_not_empty rejects an empty string', { field: 'estimate', op: 'is_not_empty' }, false],
  ];

  it.each(cases)('%s', (_name, rule, expected) => {
    expect(evaluateFilters(entry, wrap(rule), schema)).toBe(expected);
  });
});

describe('evaluateFilters — groups', () => {
  it('evaluates nested all/any groups', () => {
    const group: FilterGroup = {
      all: [
        { field: 'type', op: 'equals', value: 'Work item' },
        {
          any: [
            { field: 'status', op: 'equals', value: 'blocked' },
            { field: 'priority', op: 'equals', value: 'high' },
          ],
        },
      ],
    };
    expect(evaluateFilters(entry, group, schema)).toBe(true);
  });

  it('fails an all group when one branch fails', () => {
    const group: FilterGroup = {
      all: [
        { field: 'type', op: 'equals', value: 'Work item' },
        { field: 'status', op: 'equals', value: 'blocked' },
      ],
    };
    expect(evaluateFilters(entry, group, schema)).toBe(false);
  });

  it('an empty all group matches everything', () => {
    expect(evaluateFilters(entry, { all: [] }, schema)).toBe(true);
  });

  it('an empty any group matches nothing', () => {
    expect(evaluateFilters(entry, { any: [] }, schema)).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run src/engine/viewFilters.test.ts`
Expected: FAIL — Vitest cannot resolve import `./viewFilters` (module not yet created).

- [ ] **Step 7: Write the viewFilters implementation**

Create `src/engine/viewFilters.ts`:

```ts
import type { Entry, FilterGroup, FilterRule, Scalar, Schema } from './types';

function fieldValue(entry: Entry, field: string): unknown {
  if (field in entry.relationships) return entry.relationships[field];
  if (field in entry.properties) return entry.properties[field];
  if (field === 'type') return entry.type;
  if (field === 'title') return entry.title;
  return undefined;
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** Scalar equality, or membership when the field value is an array. */
function matchesEquals(v: unknown, target: unknown): boolean {
  return asList(v).some((x) => x !== undefined && x !== null && x === target);
}

/** Case-insensitive substring; any element for arrays. */
function matchesContains(v: unknown, target: unknown): boolean {
  if (target === undefined || target === null) return false;
  const needle = String(target).toLowerCase();
  return asList(v).some(
    (x) => x !== undefined && x !== null && String(x).toLowerCase().includes(needle),
  );
}

/** Set intersection between the field value(s) and the rule value(s). */
function matchesAnyOf(v: unknown, target: unknown): boolean {
  const targets = Array.isArray(target) ? target : [target];
  return asList(v).some((x) => x !== undefined && x !== null && targets.includes(x as Scalar));
}

function firstScalar(v: unknown): unknown {
  return Array.isArray(v) ? (v.length > 0 ? v[0] : undefined) : v;
}

function evalRule(entry: Entry, rule: FilterRule): boolean {
  const v = fieldValue(entry, rule.field);
  switch (rule.op) {
    case 'is_empty':
      return isEmptyValue(v);
    case 'is_not_empty':
      return !isEmptyValue(v);
    case 'equals':
      return matchesEquals(v, rule.value);
    case 'not_equals':
      return !matchesEquals(v, rule.value);
    case 'contains':
      return matchesContains(v, rule.value);
    case 'any_of':
      return matchesAnyOf(v, rule.value);
    case 'none_of':
      return !matchesAnyOf(v, rule.value);
    case 'before': {
      const s = firstScalar(v);
      return typeof s === 'string' && typeof rule.value === 'string' && s < rule.value;
    }
    case 'after': {
      const s = firstScalar(v);
      return typeof s === 'string' && typeof rule.value === 'string' && s > rule.value;
    }
  }
}

function isGroup(node: FilterRule | FilterGroup): node is FilterGroup {
  return 'all' in node || 'any' in node;
}

export function evaluateFilters(entry: Entry, group: FilterGroup, schema: Schema): boolean {
  const evalNode = (node: FilterRule | FilterGroup): boolean =>
    isGroup(node) ? evaluateFilters(entry, node, schema) : evalRule(entry, node);
  if ('all' in group) return group.all.every(evalNode);
  return group.any.some(evalNode);
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `pnpm vitest run src/engine/views.test.ts src/engine/viewFilters.test.ts`
Expected: PASS (2 files; every op case and group case green).

- [ ] **Step 9: Commit**

```sh
git add src/engine/views.ts src/engine/views.test.ts src/engine/viewFilters.ts src/engine/viewFilters.test.ts
git commit -m "feat: add saved-view YAML parsing and filter evaluation"
```

---

### Task 16: Engine — item keys (itemKeys.ts) and quick-open scoring (lib/quickOpenScore.ts)

**Prerequisites:** Task 12 (`testHelpers.ts`).

- `nextItemKey(prefix, entries)` scans every entry's `properties.key` for strings matching `/^PREFIX-(\d+)$/` (prefix regex-escaped, case-sensitive) and returns `PREFIX-<max+1>`; with no matching entries it returns `PREFIX-1`.
- `quickOpenScore(query, candidate)` returns `0` for no match; otherwise a positive score with three tiers — exact prefix > word-boundary match > substring — case-insensitive, with ties broken deterministically by shorter candidate. Key-shaped candidates (`FLD-7`) additionally match hyphen-less queries (`fld7`) at prefix tier.

**Files:**
- Create: `src/engine/itemKeys.ts`
- Create: `src/lib/quickOpenScore.ts`
- Test: `src/engine/itemKeys.test.ts`
- Test: `src/lib/quickOpenScore.test.ts`

- [ ] **Step 1: Write the failing itemKeys test**

Create `src/engine/itemKeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextItemKey } from './itemKeys';
import { makeEntry } from './testHelpers';

const withKeys = (...keys: (string | number)[]) =>
  keys.map((key, i) =>
    makeEntry({ path: `items/k${i}.md`, filename: `k${i}.md`, properties: { key } }),
  );

describe('nextItemKey', () => {
  it('returns PREFIX-1 for an empty entry set', () => {
    expect(nextItemKey('FLD', [])).toBe('FLD-1');
  });

  it('returns the max existing number plus one', () => {
    expect(nextItemKey('FLD', withKeys('FLD-3', 'FLD-7', 'FLD-2'))).toBe('FLD-8');
  });

  it('ignores keys with other prefixes', () => {
    expect(nextItemKey('FLD', withKeys('OPS-12', 'FLD-2'))).toBe('FLD-3');
  });

  it('ignores malformed and case-mismatched keys', () => {
    expect(nextItemKey('FLD', withKeys('FLD-', 'FLDX-4', 'fld-9', 'FLD-x'))).toBe('FLD-1');
  });

  it('ignores non-string keys and entries without keys', () => {
    expect(nextItemKey('FLD', [...withKeys(7), makeEntry({ path: 'items/nokey.md' })])).toBe(
      'FLD-1',
    );
  });

  it('escapes regex metacharacters in the prefix', () => {
    expect(nextItemKey('C++', withKeys('C++-4'))).toBe('C++-5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/itemKeys.test.ts`
Expected: FAIL — Vitest cannot resolve import `./itemKeys` (module not yet created).

- [ ] **Step 3: Write the itemKeys implementation**

Create `src/engine/itemKeys.ts`:

```ts
import type { Entry } from './types';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Next key for a project prefix: scans properties.key for ^PREFIX-(\d+)$ matches
 * across the loaded entry set and returns PREFIX-<max + 1> ('FLD-1' when none).
 */
export function nextItemKey(prefix: string, entries: Entry[]): string {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
  let max = 0;
  for (const entry of entries) {
    const key = entry.properties.key;
    if (typeof key !== 'string') continue;
    const match = pattern.exec(key);
    if (match === null) continue;
    const n = Number.parseInt(match[1], 10);
    if (n > max) max = n;
  }
  return `${prefix}-${max + 1}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/engine/itemKeys.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing quickOpenScore test**

Create `src/lib/quickOpenScore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { quickOpenScore } from './quickOpenScore';

describe('quickOpenScore', () => {
  it('returns 0 when there is no match', () => {
    expect(quickOpenScore('xyz', 'Flight deck')).toBe(0);
  });

  it('returns 0 for an empty or whitespace query and for an empty candidate', () => {
    expect(quickOpenScore('', 'Flight deck')).toBe(0);
    expect(quickOpenScore('   ', 'Flight deck')).toBe(0);
    expect(quickOpenScore('a', '')).toBe(0);
  });

  it('ranks exact prefix above word-boundary above substring', () => {
    const prefix = quickOpenScore('fli', 'Flight deck');
    const boundary = quickOpenScore('fli', 'Board flight');
    const substring = quickOpenScore('light', 'Flight deck');
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(0);
  });

  it('treats a hyphen as a word boundary', () => {
    expect(quickOpenScore('deck', 'flight-deck')).toBeGreaterThan(
      quickOpenScore('eck', 'flight-deck'), // substring only
    );
  });

  it('is case-insensitive', () => {
    expect(quickOpenScore('FLI', 'flight deck')).toBe(quickOpenScore('fli', 'FLIGHT DECK'));
    expect(quickOpenScore('FLI', 'flight deck')).toBeGreaterThan(0);
  });

  it('matches key-style candidates, with and without the hyphen in the query', () => {
    expect(quickOpenScore('fld-7', 'FLD-7')).toBeGreaterThan(0);
    expect(quickOpenScore('fld7', 'FLD-7')).toBeGreaterThan(0);
    expect(quickOpenScore('fld', 'FLD-7')).toBeGreaterThan(0);
    expect(quickOpenScore('7', 'FLD-7')).toBeGreaterThan(0); // substring
  });

  it('does not apply hyphen-less matching to non-key candidates', () => {
    // 'ab' is not a prefix, boundary, or substring of 'A Better World'
    expect(quickOpenScore('ab', 'A Better World')).toBe(0);
  });

  it('breaks ties deterministically by shorter candidate', () => {
    expect(quickOpenScore('doc', 'Docs')).toBeGreaterThan(
      quickOpenScore('doc', 'Documentation hub'),
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run src/lib/quickOpenScore.test.ts`
Expected: FAIL — Vitest cannot resolve import `./quickOpenScore` (module not yet created).

- [ ] **Step 7: Write the quickOpenScore implementation**

Create `src/lib/quickOpenScore.ts`:

```ts
const KEY_SHAPE = /^[a-z]+-\d+$/i;

function hasWordBoundaryMatch(candidate: string, query: string): boolean {
  let idx = candidate.indexOf(query);
  while (idx !== -1) {
    if (idx === 0) return true;
    const prev = candidate[idx - 1];
    if (prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '.') return true;
    idx = candidate.indexOf(query, idx + 1);
  }
  return false;
}

/**
 * Fuzzy score for quick open (⌘K). 0 = no match; higher = better.
 * Tiers: exact prefix (3) > word-boundary (2) > substring (1), case-insensitive.
 * Key-shaped candidates ('FLD-7') also match hyphen-less queries ('fld7') at prefix tier.
 * Ties within a tier break deterministically toward the shorter candidate.
 */
export function quickOpenScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (q === '' || c === '') return 0;

  let tier = 0;
  if (c.startsWith(q)) tier = 3;
  else if (hasWordBoundaryMatch(c, q)) tier = 2;
  else if (c.includes(q)) tier = 1;
  else if (KEY_SHAPE.test(candidate)) {
    const qKey = q.replace(/[^a-z0-9]/g, '');
    const cKey = c.replace(/-/g, '');
    if (qKey !== '' && cKey.startsWith(qKey)) tier = 3;
  }

  if (tier === 0) return 0;
  return tier * 1000 - Math.min(candidate.length, 999);
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `pnpm vitest run src/engine/itemKeys.test.ts src/lib/quickOpenScore.test.ts`
Expected: PASS (2 files green).

- [ ] **Step 9: Run the full engine suite as a regression gate**

Run: `pnpm vitest run src/engine src/lib`
Expected: PASS — wikilink, normalize, schema, grouping, views, viewFilters, itemKeys, quickOpenScore all green.

- [ ] **Step 10: Commit**

```sh
git add src/engine/itemKeys.ts src/engine/itemKeys.test.ts src/lib/quickOpenScore.ts src/lib/quickOpenScore.test.ts
git commit -m "feat: add item key generation and quick-open scoring"
```

### Task 17: navStore + uiStore + app shell (Rail, Topbar, Sidebar frame, boot flow)

**Files:**
- Create: `src/stores/navStore.ts`
- Create: `src/stores/uiStore.ts`
- Create: `src/app/Rail.tsx`
- Create: `src/app/Topbar.tsx`
- Create: `src/app/Sidebar.tsx`
- Modify: `src/App.tsx` (replace the Task 1 placeholder entirely)
- Test: `src/stores/navStore.test.ts`
- Test: `src/stores/uiStore.test.ts`
- Test: `src/App.test.tsx`

Context for the executing engineer: this task produces the navigable shell from the prototype (`docs/cerebro-with-teams/CerebroApp.dc.html` lines 44–181): a 56px icon rail, a 264px sidebar frame on `--surface-sunken`, a 64px topbar, and a canvas outlet that switches on `navStore.selection.kind`. Boot flow: `getLastVault()` → `openVault(path)`; with no configured vault, render a centered vault-chooser card. DS primitives used (prop APIs from `docs/Cerebro Design System/components/*/*.d.ts`):

- `Button`: `variant?: "primary"|"secondary"|"ghost"|"danger"; size?: "sm"|"md"|"lg"; icon?: string; onClick?: () => void; children`
- `Icon`: `name: string; size?: number; color?: string` (lucide kebab-case, stroke 1.75 default)
- `Tooltip`: `content: React.ReactNode; children`
- `Avatar`: `name: string; size?: number`

- [ ] **Step 1: Write the failing store tests**

`src/stores/navStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useNavStore } from './navStore';

function reset() {
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [{ kind: 'home' }],
    historyIndex: 0,
  });
}

describe('navStore', () => {
  beforeEach(reset);

  it('starts at home with a one-entry history', () => {
    const s = useNavStore.getState();
    expect(s.selection).toEqual({ kind: 'home' });
    expect(s.history).toEqual([{ kind: 'home' }]);
    expect(s.historyIndex).toBe(0);
  });

  it('navigate pushes onto history and moves the index', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'space', path: 'spaces/product.md' });
    navigate({ kind: 'project', path: 'projects/foundations.md' });
    const s = useNavStore.getState();
    expect(s.selection).toEqual({ kind: 'project', path: 'projects/foundations.md' });
    expect(s.history).toHaveLength(3);
    expect(s.historyIndex).toBe(2);
  });

  it('navigate after back truncates the forward stack', () => {
    const { navigate, back, forward } = useNavStore.getState();
    navigate({ kind: 'space', path: 'spaces/product.md' });
    navigate({ kind: 'project', path: 'projects/foundations.md' });
    back();
    navigate({ kind: 'settings' });
    const s = useNavStore.getState();
    expect(s.history).toEqual([
      { kind: 'home' },
      { kind: 'space', path: 'spaces/product.md' },
      { kind: 'settings' },
    ]);
    expect(s.historyIndex).toBe(2);
    forward(); // nothing ahead — must be a no-op
    expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
  });

  it('back clamps at the start of history', () => {
    const { back } = useNavStore.getState();
    back();
    back();
    const s = useNavStore.getState();
    expect(s.selection).toEqual({ kind: 'home' });
    expect(s.historyIndex).toBe(0);
  });

  it('back and forward walk the history', () => {
    const { navigate, back, forward } = useNavStore.getState();
    navigate({ kind: 'space', path: 'spaces/product.md' });
    back();
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    forward();
    expect(useNavStore.getState().selection).toEqual({ kind: 'space', path: 'spaces/product.md' });
    forward(); // at the tip — no-op
    expect(useNavStore.getState().historyIndex).toBe(1);
  });
});
```

`src/stores/uiStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './uiStore';

function reset() {
  useUiStore.setState({ detailPath: null, quickOpenVisible: false, toasts: [] });
}

describe('uiStore', () => {
  beforeEach(reset);

  it('openDetail and closeDetail set detailPath', () => {
    useUiStore.getState().openDetail('items/fld-7.md');
    expect(useUiStore.getState().detailPath).toBe('items/fld-7.md');
    useUiStore.getState().closeDetail();
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('setQuickOpen toggles quickOpenVisible', () => {
    useUiStore.getState().setQuickOpen(true);
    expect(useUiStore.getState().quickOpenVisible).toBe(true);
    useUiStore.getState().setQuickOpen(false);
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('toast assigns unique increasing ids automatically', () => {
    const { toast } = useUiStore.getState();
    toast('Saved');
    toast('Vault refreshed');
    const toasts = useUiStore.getState().toasts;
    expect(toasts.map((t) => t.message)).toEqual(['Saved', 'Vault refreshed']);
    expect(toasts[1].id).toBeGreaterThan(toasts[0].id);
    expect(new Set(toasts.map((t) => t.id)).size).toBe(2);
  });

  it('dismissToast removes only the matching toast', () => {
    const { toast } = useUiStore.getState();
    toast('First');
    toast('Second');
    const first = useUiStore.getState().toasts[0];
    useUiStore.getState().dismissToast(first.id);
    const remaining = useUiStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message).toBe('Second');
  });
});
```

- [ ] **Step 2: Run store tests to verify they fail**

Run: `pnpm vitest run src/stores/navStore.test.ts src/stores/uiStore.test.ts`
Expected: FAIL — `Cannot find module './navStore'` / `'./uiStore'` (files do not exist yet).

- [ ] **Step 3: Implement the stores**

`src/stores/navStore.ts` (exact API from the plan's Shared contracts):

```ts
import { create } from 'zustand';
import type { Selection } from '@/engine/types';

interface NavState {
  selection: Selection;
  history: Selection[];
  historyIndex: number;
  navigate(sel: Selection): void;
  back(): void;
  forward(): void;
}

export const useNavStore = create<NavState>((set, get) => ({
  selection: { kind: 'home' },
  history: [{ kind: 'home' }],
  historyIndex: 0,

  navigate(sel) {
    const { history, historyIndex } = get();
    const next = [...history.slice(0, historyIndex + 1), sel];
    set({ selection: sel, history: next, historyIndex: next.length - 1 });
  },

  back() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    set({ selection: history[index], historyIndex: index });
  },

  forward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    set({ selection: history[index], historyIndex: index });
  },
}));
```

`src/stores/uiStore.ts` (exact API from the plan's Shared contracts):

```ts
import { create } from 'zustand';

interface UiState {
  detailPath: string | null;
  openDetail(path: string): void;
  closeDetail(): void;
  quickOpenVisible: boolean;
  setQuickOpen(v: boolean): void;
  toasts: { id: number; message: string }[];
  toast(message: string): void;
  dismissToast(id: number): void;
}

let nextToastId = 1;

export const useUiStore = create<UiState>((set) => ({
  detailPath: null,
  openDetail: (path) => set({ detailPath: path }),
  closeDetail: () => set({ detailPath: null }),

  quickOpenVisible: false,
  setQuickOpen: (v) => set({ quickOpenVisible: v }),

  toasts: [],
  toast: (message) =>
    set((s) => ({ toasts: [...s.toasts, { id: nextToastId++, message }] })),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
```

- [ ] **Step 4: Run store tests to verify they pass**

Run: `pnpm vitest run src/stores/navStore.test.ts src/stores/uiStore.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing App boot test**

`src/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    getLastVault: vi.fn(async () => '/demo-vault'),
    pickVault: vi.fn(async () => null),
    scanVault: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    startWatcher: vi.fn(async () => {}),
  };
});

import App from '@/App';
import * as ipc from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

describe('App boot flow', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: null,
      entries: [],
      views: [],
      status: 'idle',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  afterEach(cleanup);

  it('opens the last vault on boot and shows the sidebar', async () => {
    render(<App />);
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
    expect(vi.mocked(ipc.getLastVault)).toHaveBeenCalled();
    expect(screen.queryByText('Open demo vault')).toBeNull();
  });

  it('shows the vault chooser when no vault is configured', async () => {
    vi.mocked(ipc.getLastVault).mockResolvedValueOnce(null);
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Open demo vault' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
  });
});
```

- [ ] **Step 6: Run the App test to verify it fails**

Run: `pnpm vitest run src/App.test.tsx`
Expected: FAIL — the placeholder `App.tsx` renders neither a `navigation` landmark named "Sidebar" nor an "Open demo vault" button.

- [ ] **Step 7: Write Rail.tsx**

`src/app/Rail.tsx` — 56px rail per prototype lines 46–58: `c.` logo tile on `--cortex-500`, Home active, Docs/Agent/Library rendered but disabled with a "Coming soon" tooltip, Settings pinned to the bottom.

```tsx
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';
import { useNavStore } from '@/stores/navStore';

const COMING_SOON = [
  { icon: 'files', label: 'Docs' },
  { icon: 'zap', label: 'Agent' },
  { icon: 'library', label: 'Library' },
];

function RailButton({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const tone = disabled
    ? 'cursor-default text-[var(--n-300)]'
    : active
      ? 'bg-[var(--cortex-50)] text-[var(--cortex-600)]'
      : 'text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-11 flex-col items-center gap-[3px] rounded-lg border-0 bg-transparent pb-[5px] pt-1.5 text-[10px] font-medium ${tone}`}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  );
}

export function Rail() {
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const settingsActive = selection.kind === 'settings';

  return (
    <div className="flex w-14 flex-none flex-col items-center gap-1 border-r border-[var(--n-100)] bg-[var(--n-0)] py-3">
      <div className="mb-3 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-[var(--cortex-500)] text-[17px] font-bold tracking-[-0.02em] text-white">
        c.
      </div>
      <RailButton
        icon="home"
        label="Home"
        active={!settingsActive}
        onClick={() => navigate({ kind: 'home' })}
      />
      {COMING_SOON.map((item) => (
        <Tooltip key={item.label} content="Coming soon">
          <RailButton icon={item.icon} label={item.label} disabled />
        </Tooltip>
      ))}
      <div className="flex-1" />
      <RailButton
        icon="settings"
        label="Settings"
        active={settingsActive}
        onClick={() => navigate({ kind: 'settings' })}
      />
    </div>
  );
}
```

- [ ] **Step 8: Write Topbar.tsx**

`src/app/Topbar.tsx` — 64px bar per prototype lines 152–179: wordmark `cerebro` with a Synapse-violet period, a centered input-lookalike button that opens quick open (⌘K), a primary `+ New` button, and an avatar placeholder. The `onNew` prop is a seam: Task 23 wires it to CreateMenu; until then App passes a no-op.

```tsx
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useUiStore } from '@/stores/uiStore';

export function Topbar({ onNew }: { onNew: () => void }) {
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);

  return (
    <div className="relative z-[5] flex h-16 flex-none items-center gap-3 border-b border-[var(--n-200)] bg-[var(--n-0)] px-4">
      <span className="text-[16px] font-bold tracking-[-0.02em]">
        cerebro<span className="text-[var(--synapse-500)]">.</span>
      </span>
      <div className="flex flex-1 justify-center">
        <button
          type="button"
          onClick={() => setQuickOpen(true)}
          className="flex h-9 w-[480px] items-center gap-2 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-25)] px-3 text-[13px] text-[var(--n-400)] hover:border-[var(--n-300)]"
        >
          <Icon name="search" size={15} />
          <span className="flex-1 text-left">Search or jump to…</span>
          <kbd className="rounded-[5px] border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 text-[11px] text-[var(--n-500)] [font-family:var(--font-mono)]">
            ⌘K
          </kbd>
        </button>
      </div>
      <Button variant="primary" size="sm" icon="plus" onClick={onNew}>
        New
      </Button>
      <Avatar name="You" size={28} />
    </div>
  );
}
```

- [ ] **Step 9: Write the Sidebar frame**

`src/app/Sidebar.tsx` — 264px frame on `--surface-sunken` per prototype lines 62–66. Task 18 replaces the placeholder body with the spaces tree and views section.

```tsx
export function Sidebar() {
  return (
    <nav
      aria-label="Sidebar"
      className="flex w-[264px] flex-none flex-col overflow-hidden border-r border-[var(--n-200)] bg-[var(--surface-sunken)]"
    >
      <div className="flex items-center justify-between pb-2 pl-4 pr-3 pt-3.5">
        <h1 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">Workspace</h1>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {/* Spaces tree + views section land in Task 18 */}
      </div>
    </nav>
  );
}
```

- [ ] **Step 10: Write App.tsx (shell composition + boot flow + vault chooser)**

Replace `src/App.tsx` entirely with:

```tsx
import { useEffect, useState } from 'react';
import { Rail } from '@/app/Rail';
import { Sidebar } from '@/app/Sidebar';
import { Topbar } from '@/app/Topbar';
import { Button } from '@/components/ui/Button';
import { getLastVault, pickVault } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function CanvasPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--n-400)]">
      {label}
    </div>
  );
}

function CanvasOutlet() {
  const selection = useNavStore((s) => s.selection);
  switch (selection.kind) {
    case 'home': return <CanvasPlaceholder label="Home" />;
    case 'space': return <CanvasPlaceholder label="Space" />;
    case 'project': return <CanvasPlaceholder label="Project" />;
    case 'view': return <CanvasPlaceholder label="View" />;
    case 'settings': return <CanvasPlaceholder label="Settings" />;
  }
}

function VaultChooser() {
  const openVault = useVaultStore((s) => s.openVault);
  const error = useVaultStore((s) => s.error);

  const openDemo = async () => {
    if (isTauri) {
      const path = await pickVault();
      if (path) await openVault(path);
    } else {
      await openVault('/demo-vault');
    }
  };

  const chooseFolder = async () => {
    const path = await pickVault();
    if (path) await openVault(path);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--n-25)]">
      <div className="flex w-[380px] flex-col gap-3 rounded-[14px] border border-[var(--n-200)] bg-[var(--n-0)] p-7 shadow-[var(--shadow-md)]">
        <span className="text-[18px] font-bold tracking-[-0.02em]">
          cerebro<span className="text-[var(--synapse-500)]">.</span>
        </span>
        <h1 className="m-0 text-[16px] font-semibold text-[var(--n-900)]">Open a vault</h1>
        <p className="m-0 text-[13px] leading-[19px] text-[var(--n-600)]">
          A vault is a folder of markdown files — spaces, projects, and work items live there as
          plain text.
        </p>
        {error ? <p className="m-0 text-[12px] text-[var(--danger-500)]">{error}</p> : null}
        <div className="mt-1 flex gap-2">
          <Button variant="primary" onClick={openDemo}>Open demo vault</Button>
          <Button variant="secondary" onClick={chooseFolder}>Choose folder…</Button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const last = await getLastVault();
      if (last && !cancelled) await openVault(last);
      if (!cancelled) setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [openVault]);

  if (!vaultPath) {
    return booted ? <VaultChooser /> : null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--n-0)] text-[13px] leading-5 text-[var(--n-900)]">
      <Rail />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onNew={() => { /* CreateMenu wiring lands in Task 23 */ }} />
        <div className="flex min-h-0 flex-1 bg-[var(--n-0)]">
          <CanvasOutlet />
        </div>
      </div>
    </div>
  );
}

export { App };
export default App;
```

Keep the single-line `case` statements exactly as written — Tasks 18/19/23 replace them with exact string edits.

- [ ] **Step 11: Run all task tests to verify they pass**

Run: `pnpm vitest run src/stores/navStore.test.ts src/stores/uiStore.test.ts src/App.test.tsx`
Expected: PASS (11 tests).

- [ ] **Step 12: Verify the shell in the browser**

Run: `pnpm dev`
Expected: with no last vault configured in the mock, the centered "Open a vault" card appears; clicking "Open demo vault" swaps to the shell — 56px rail (Home tinted cortex, Docs/Agent/Library grayed with "Coming soon" on hover, Settings at bottom), 264px sunken sidebar titled "Workspace", 64px topbar with `cerebro.` wordmark (violet period), centered ⌘K search trigger, primary "New" button, avatar. Clicking Settings shows the "Settings" placeholder canvas; clicking Home returns.

- [ ] **Step 13: Commit**

```sh
git add src/stores/navStore.ts src/stores/navStore.test.ts src/stores/uiStore.ts src/stores/uiStore.test.ts src/app/Rail.tsx src/app/Topbar.tsx src/app/Sidebar.tsx src/App.tsx src/App.test.tsx
git commit -m "feat: add nav and ui stores, app shell, and vault boot flow"
```

---

### Task 18: Sidebar content (spaces tree + views) + HomePage

**Files:**
- Create: `src/lib/swatch.ts`
- Create: `src/pages/HomePage.tsx`
- Modify: `src/app/Sidebar.tsx` (full rewrite of the Task 17 frame body)
- Modify: `src/App.tsx` (two exact edits)
- Test: `src/lib/swatch.test.ts`
- Test: `src/app/Sidebar.test.tsx`
- Test: `src/pages/HomePage.test.tsx`

Context: mirrors the prototype's sidebar sections (lines 123–145: 11px uppercase section labels, 30px rows, 18px letter swatches, chevron collapse) and Home screen (lines 2105–2177: greeting header, 3-col spaces grid, 2-col projects grid with progress bars). All data comes from `useVaultStore` selectors + `useSchema()`. DS primitives used:

- `Icon`: `name: string; size?: number; color?: string`
- `Button`: `variant?; size?; icon?; onClick?; children`
- `Tag`: `children; color?: string; icon?: string; style?`
- `ProgressBar`: `value: number (0–100); width?: number; showLabel?: boolean`

The `onNewProject(spacePath)` prop is a seam for CreateMenu (built in Task 23, prefilled with the space); App passes a stub until then.

- [ ] **Step 1: Write the failing swatch test**

`src/lib/swatch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { swatchColor } from './swatch';

describe('swatchColor', () => {
  it('passes hex colors through', () => {
    expect(swatchColor('#3D8BE8')).toBe('#3D8BE8');
  });

  it('passes css variables through', () => {
    expect(swatchColor('var(--cortex-500)')).toBe('var(--cortex-500)');
  });

  it('maps DS swatch names to swatch variables', () => {
    expect(swatchColor('teal')).toBe('var(--swatch-teal)');
  });

  it('falls back to cortex for missing values', () => {
    expect(swatchColor(null)).toBe('var(--cortex-500)');
    expect(swatchColor('')).toBe('var(--cortex-500)');
    expect(swatchColor(42)).toBe('var(--cortex-500)');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/swatch.test.ts`
Expected: FAIL — `Cannot find module './swatch'`.

- [ ] **Step 3: Implement swatch.ts**

`src/lib/swatch.ts`:

```ts
const FALLBACK = 'var(--cortex-500)';

/** Resolve a frontmatter color value (hex, css var, or DS swatch name) to a CSS color. */
export function swatchColor(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return FALLBACK;
  const value = raw.trim();
  if (value.startsWith('#') || value.startsWith('var(')) return value;
  return `var(--swatch-${value})`;
}
```

Run: `pnpm vitest run src/lib/swatch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing Sidebar behavior test**

`src/app/Sidebar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { Sidebar } from './Sidebar';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    title: 'Untitled',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    ...partial,
  };
}

const space = mkEntry({
  path: 'spaces/product.md',
  filename: 'product.md',
  title: 'Product',
  type: 'Space',
  properties: { color: 'blue' },
});
const project = mkEntry({
  path: 'projects/foundations.md',
  filename: 'foundations.md',
  title: 'Foundations',
  type: 'Project',
  relationships: { space: ['product'] },
});

describe('Sidebar', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [space, project],
      views: [
        {
          id: 'urgent-work',
          definition: {
            name: 'Urgent work',
            icon: null,
            color: null,
            order: null,
            filters: null,
            presentation: {
              type: 'list',
              groupBy: 'status',
              orderBy: { field: 'modifiedAt', dir: 'desc' },
              visibleFields: ['key', 'status'],
            },
          },
        },
      ],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  afterEach(cleanup);

  it('renders spaces with nested project rows and saved views', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByText('Urgent work')).toBeTruthy();
  });

  it('collapsing a space hides its projects', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Product' }));
    expect(screen.queryByText('Foundations')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Product' }));
    expect(screen.getByText('Foundations')).toBeTruthy();
  });

  it('clicking rows navigates to space, project, and view', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    fireEvent.click(screen.getByText('Foundations'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'project',
      path: 'projects/foundations.md',
    });
    fireEvent.click(screen.getByText('Urgent work'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'view', id: 'urgent-work' });
  });

  it('new project row calls onNewProject with the space path', () => {
    const onNewProject = vi.fn();
    render(<Sidebar onNewProject={onNewProject} />);
    fireEvent.click(screen.getByText('New project'));
    expect(onNewProject).toHaveBeenCalledWith('spaces/product.md');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm vitest run src/app/Sidebar.test.tsx`
Expected: FAIL — the Task 17 `Sidebar` takes no props and renders no spaces/views (`getByText('Product')` throws), plus a TS error for the unknown `onNewProject` prop.

- [ ] **Step 6: Rewrite Sidebar.tsx with the spaces tree and views section**

Replace `src/app/Sidebar.tsx` entirely with:

```tsx
import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { swatchColor } from '@/lib/swatch';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

export interface SidebarProps {
  /** Opens CreateMenu prefilled with the space (wired in Task 23). */
  onNewProject: (spacePath: string) => void;
}

const SECTION_LABEL =
  'px-2 pb-1 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]';

function rowClass(active: boolean): string {
  return [
    'flex h-[30px] w-full items-center gap-[7px] rounded-md border-0 px-2 text-left text-[13px]',
    active
      ? 'bg-[var(--n-100)] font-medium text-[var(--n-900)]'
      : 'bg-transparent font-normal text-[var(--n-700)] hover:bg-[var(--n-100)]',
  ].join(' ');
}

export function Sidebar({ onNewProject }: SidebarProps) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const spaces = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Space')
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries],
  );

  const projectsBySpace = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const project of entries.filter((e) => e.type === 'Project')) {
      const target = project.relationships.space?.[0];
      const projectSpace = target ? resolveTarget(target, entries) : null;
      if (!projectSpace) continue;
      const list = map.get(projectSpace.path) ?? [];
      list.push(project);
      map.set(projectSpace.path, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title));
    return map;
  }, [entries]);

  const sortedViews = useMemo(
    () =>
      [...views].sort(
        (a, b) =>
          (a.definition.order ?? 0) - (b.definition.order ?? 0) ||
          a.definition.name.localeCompare(b.definition.name),
      ),
    [views],
  );

  const toggle = (path: string) => setCollapsed((c) => ({ ...c, [path]: !c[path] }));

  return (
    <nav
      aria-label="Sidebar"
      className="flex w-[264px] flex-none flex-col overflow-hidden border-r border-[var(--n-200)] bg-[var(--surface-sunken)]"
    >
      <div className="flex items-center justify-between pb-2 pl-4 pr-3 pt-3.5">
        <h1 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">Workspace</h1>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <div className={SECTION_LABEL}>Spaces</div>
        {spaces.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-[var(--n-400)]">No spaces yet</div>
        ) : null}
        {spaces.map((space) => {
          const isCollapsed = collapsed[space.path] ?? false;
          const spaceActive = selection.kind === 'space' && selection.path === space.path;
          const spaceProjects = projectsBySpace.get(space.path) ?? [];
          return (
            <div key={space.path}>
              <button
                type="button"
                onClick={() => navigate({ kind: 'space', path: space.path })}
                className={rowClass(spaceActive)}
              >
                <span
                  role="button"
                  aria-label={`Toggle ${space.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(space.path);
                  }}
                  className="inline-flex flex-none text-[var(--n-400)] transition-transform duration-[120ms]"
                  style={{ transform: `rotate(${isCollapsed ? 0 : 90}deg)` }}
                >
                  <Icon name="chevron-right" size={13} />
                </span>
                <span
                  className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] text-[10px] font-bold text-white"
                  style={{ background: swatchColor(space.properties.color) }}
                >
                  {space.title.charAt(0).toUpperCase()}
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {space.title}
                </span>
              </button>
              {!isCollapsed
                ? spaceProjects.map((project) => {
                    const projectActive =
                      selection.kind === 'project' && selection.path === project.path;
                    return (
                      <button
                        key={project.path}
                        type="button"
                        onClick={() => navigate({ kind: 'project', path: project.path })}
                        className={`${rowClass(projectActive)} pl-[26px]`}
                      >
                        <Icon name="folder-kanban" size={15} color="var(--n-500)" />
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                          {project.title}
                        </span>
                      </button>
                    );
                  })
                : null}
              {!isCollapsed ? (
                <button
                  type="button"
                  onClick={() => onNewProject(space.path)}
                  className="flex h-[30px] w-full items-center gap-[7px] rounded-md border-0 bg-transparent pl-[26px] pr-2 text-left text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-700)]"
                >
                  <Icon name="plus" size={13} />
                  New project
                </button>
              ) : null}
            </div>
          );
        })}
        <div className={SECTION_LABEL}>Views</div>
        {sortedViews.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-[var(--n-400)]">No saved views</div>
        ) : null}
        {sortedViews.map((view) => {
          const viewActive = selection.kind === 'view' && selection.id === view.id;
          return (
            <button
              key={view.id}
              type="button"
              onClick={() => navigate({ kind: 'view', id: view.id })}
              className={rowClass(viewActive)}
            >
              <Icon name={view.definition.icon ?? 'layout-list'} size={15} color="var(--n-500)" />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {view.definition.name}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
```

- [ ] **Step 7: Run the Sidebar test to verify it passes**

Run: `pnpm vitest run src/app/Sidebar.test.tsx`
Expected: FAIL only on TS in `src/App.tsx` if run with typecheck (App still renders `<Sidebar />` without the required prop) — fix in Step 8 below; the four Sidebar tests themselves PASS.

- [ ] **Step 8: Wire the Sidebar prop in App.tsx**

Edit `src/App.tsx` — replace:

```tsx
      <Sidebar />
```

with:

```tsx
      <Sidebar onNewProject={() => { /* CreateMenu wiring lands in Task 23 */ }} />
```

Run: `pnpm vitest run src/app/Sidebar.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 9: Write the failing HomePage tests**

`src/pages/HomePage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, Schema, StatusDef } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { greetingForHour, HomePage, projectProgress } from './HomePage';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    title: 'Untitled',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    ...partial,
  };
}

const space = mkEntry({
  path: 'spaces/product.md',
  filename: 'product.md',
  title: 'Product',
  type: 'Space',
  properties: { color: '#3D8BE8' },
  snippet: 'Everything customer-facing.',
});
const project = mkEntry({
  path: 'projects/foundations.md',
  filename: 'foundations.md',
  title: 'Foundations',
  type: 'Project',
  properties: { key: 'FLD' },
  relationships: { space: ['product'] },
});
const itemDone = mkEntry({
  path: 'items/fld-1.md',
  filename: 'fld-1.md',
  title: 'Ship tokens',
  properties: { status: 'done' },
  relationships: { project: ['foundations'] },
});
const itemOpen = mkEntry({
  path: 'items/fld-2.md',
  filename: 'fld-2.md',
  title: 'Port primitives',
  properties: { status: 'todo' },
  relationships: { project: ['foundations'] },
});

const STATUSES: StatusDef[] = [
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
];

const fakeSchema: Schema = {
  types: new Map(),
  spaceForEntry: () => space,
  statusSetForSpace: () => STATUSES,
  resolveField: () => ({ def: null, raw: null, display: '', color: null, ghost: false }),
};

describe('greetingForHour', () => {
  it('says good morning before noon', () => {
    expect(greetingForHour(0)).toBe('Good morning');
    expect(greetingForHour(9)).toBe('Good morning');
  });
  it('says good afternoon from noon to 6pm', () => {
    expect(greetingForHour(12)).toBe('Good afternoon');
    expect(greetingForHour(17)).toBe('Good afternoon');
  });
  it('says good evening from 6pm', () => {
    expect(greetingForHour(18)).toBe('Good evening');
    expect(greetingForHour(23)).toBe('Good evening');
  });
});

describe('projectProgress', () => {
  const entries = [space, project, itemDone, itemOpen];

  it('counts done-group items over total items of the project', () => {
    expect(projectProgress(project, entries, fakeSchema)).toEqual({ total: 2, done: 1 });
  });

  it('returns zeros for a project with no items', () => {
    const empty = mkEntry({ path: 'projects/empty.md', title: 'Empty', type: 'Project' });
    expect(projectProgress(empty, entries, fakeSchema)).toEqual({ total: 0, done: 0 });
  });

  it('does not count items whose status is not in the status set', () => {
    const ghost = mkEntry({
      path: 'items/fld-3.md',
      filename: 'fld-3.md',
      properties: { status: 'someday' },
      relationships: { project: ['foundations'] },
    });
    expect(projectProgress(project, [...entries, ghost], fakeSchema)).toEqual({
      total: 3,
      done: 1,
    });
  });
});

describe('HomePage', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [space, project, itemDone, itemOpen],
      views: [],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  afterEach(cleanup);

  it('renders space tiles with project counts and the projects grid', () => {
    render(<HomePage />);
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.getByText('1 project')).toBeTruthy();
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByText('FLD')).toBeTruthy();
    expect(screen.getByText('1/2 done')).toBeTruthy();
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm vitest run src/pages/HomePage.test.tsx`
Expected: FAIL — `Cannot find module './HomePage'`.

- [ ] **Step 11: Implement HomePage.tsx**

`src/pages/HomePage.tsx`:

```tsx
import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Tag } from '@/components/ui/Tag';
import type { Entry, Schema } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { swatchColor } from '@/lib/swatch';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Items belonging to the project, and how many sit in a done-group status. */
export function projectProgress(
  project: Entry,
  entries: Entry[],
  schema: Schema,
): { total: number; done: number } {
  const items = entries.filter((e) =>
    (e.relationships.project ?? []).some((t) => resolveTarget(t, entries)?.path === project.path),
  );
  let done = 0;
  for (const item of items) {
    const itemSpace = schema.spaceForEntry(item);
    const statuses = schema.statusSetForSpace(itemSpace?.path ?? null);
    const def = statuses.find((s) => s.id === item.properties.status);
    if (def?.group === 'done') done += 1;
  }
  return { total: items.length, done };
}

const CARD =
  'flex min-w-0 flex-col gap-2 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-[14px] py-[13px] text-left hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)]';

export function ProjectCard({ project, subtitle }: { project: Entry; subtitle: string }) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const { total, done } = useMemo(
    () => projectProgress(project, entries, schema),
    [project, entries, schema],
  );
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const projectKey =
    typeof project.properties.key === 'string' ? project.properties.key : null;

  return (
    <button
      type="button"
      onClick={() => navigate({ kind: 'project', path: project.path })}
      className={CARD}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="folder-kanban" size={15} color="var(--n-500)" />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-[var(--n-900)]">
          {project.title}
        </span>
        <span className="flex-1" />
        {projectKey ? (
          <Tag style={{ fontFamily: 'var(--font-mono)' }}>{projectKey}</Tag>
        ) : null}
      </div>
      <div className="text-[11.5px] text-[var(--n-500)]">{subtitle}</div>
      <div className="flex items-center gap-2">
        <ProgressBar value={percent} width={150} />
        <span className="text-[11px] text-[var(--n-600)] [font-family:var(--font-mono)]">
          {done}/{total} done
        </span>
      </div>
    </button>
  );
}

export function HomePage() {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);

  const spaces = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Space')
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries],
  );
  const projects = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Project')
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    [entries],
  );
  const projectCountBySpace = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of entries.filter((e) => e.type === 'Project')) {
      const target = project.relationships.space?.[0];
      const space = target ? resolveTarget(target, entries) : null;
      if (space) map.set(space.path, (map.get(space.path) ?? 0) + 1);
    }
    return map;
  }, [entries]);
  const spaceTitleFor = (project: Entry): string => {
    const target = project.relationships.space?.[0];
    const space = target ? resolveTarget(target, entries) : null;
    return space?.title ?? '—';
  };

  const greeting = greetingForHour(new Date().getHours());

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--n-0)]">
      <div className="mx-auto max-w-[1080px] px-8 pb-14 pt-8">
        <div className="mb-[18px] flex items-baseline gap-3">
          <h1 className="m-0 text-[22px] font-semibold leading-[30px] tracking-[-0.015em]">
            {greeting}
          </h1>
          <span className="text-[12px] text-[var(--n-500)]">
            {spaces.length} {spaces.length === 1 ? 'space' : 'spaces'} · {projects.length}{' '}
            {projects.length === 1 ? 'project' : 'projects'}
          </span>
        </div>

        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Spaces</h2>
        </div>
        <div className="mb-[30px] grid grid-cols-3 gap-2.5">
          {spaces.map((space) => {
            const count = projectCountBySpace.get(space.path) ?? 0;
            return (
              <button
                key={space.path}
                type="button"
                onClick={() => navigate({ kind: 'space', path: space.path })}
                className="flex min-w-0 flex-col gap-[9px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-[14px] py-[13px] text-left hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)]"
              >
                <div className="flex min-w-0 items-center gap-[9px]">
                  <span
                    className="inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] text-[12px] font-bold text-white"
                    style={{ background: swatchColor(space.properties.color) }}
                  >
                    {space.title.charAt(0).toUpperCase()}
                  </span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-[var(--n-900)]">
                    {space.title}
                  </span>
                </div>
                {space.snippet ? (
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-[var(--n-500)]">
                    {space.snippet}
                  </div>
                ) : null}
                <div className="text-[12px] text-[var(--n-500)]">
                  {count === 1 ? '1 project' : `${count} projects`}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Active projects</h2>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {projects.map((project) => (
            <ProjectCard key={project.path} project={project} subtitle={spaceTitleFor(project)} />
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 12: Run HomePage tests to verify they pass**

Run: `pnpm vitest run src/pages/HomePage.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 13: Mount HomePage in the canvas outlet**

Edit `src/App.tsx` — replace:

```tsx
import { Sidebar } from '@/app/Sidebar';
```

with:

```tsx
import { Sidebar } from '@/app/Sidebar';
import { HomePage } from '@/pages/HomePage';
```

and replace:

```tsx
    case 'home': return <CanvasPlaceholder label="Home" />;
```

with:

```tsx
    case 'home': return <HomePage />;
```

- [ ] **Step 14: Verify in the browser and re-run the suite**

Run: `pnpm dev`
Expected: the demo vault home shows the local-hour greeting, a 3-column spaces grid (letter swatches in space colors, description snippets, project counts), and a 2-column active-projects grid (folder-kanban icon, mono key Tag, space name, progress bar with `n/m done`). Sidebar shows collapsible spaces with nested projects, per-space "New project" rows, and the Views section. Clicking tiles/rows updates the canvas placeholder for space/project.

Run: `pnpm vitest run src`
Expected: PASS — all suites, including Task 17's `App.test.tsx`.

- [ ] **Step 15: Commit**

```sh
git add src/lib/swatch.ts src/lib/swatch.test.ts src/app/Sidebar.tsx src/app/Sidebar.test.tsx src/pages/HomePage.tsx src/pages/HomePage.test.tsx src/App.tsx
git commit -m "feat: add sidebar spaces tree, views section, and home page"
```

---

### Task 19: SpacePage + ProjectPage + ViewToolbar

**Files:**
- Create: `src/views/ViewToolbar.tsx`
- Create: `src/views/ListView.tsx` (placeholder — Task 20 replaces the body, keeping the props and root `data-testid="list-view"`)
- Create: `src/views/BoardView.tsx` (placeholder — Task 21 replaces the body, keeping the props and root `data-testid="board-view"`)
- Create: `src/pages/SpacePage.tsx`
- Create: `src/pages/ProjectPage.tsx`
- Modify: `src/App.tsx` (three exact edits)
- Test: `src/views/ViewToolbar.test.tsx`
- Test: `src/pages/ProjectPage.test.tsx`

Context: mirrors the prototype's Space screen (lines 2253–2357: 34px letter swatch header, description at 46px indent, status chips strip, 2-col projects grid) and Project screen header (lines 2363–2396: `Space / Project` breadcrumb with 18px space tile, view-switcher + group-by controls). Presentation state lives in ProjectPage local state, initialized from `resolveCollection` defaults; a `{kind: 'view'}` selection gets the saved view's presentation via the same call. DS primitives used:

- `SegmentedControl`: `options: {value; label; icon?}[]; value?; onChange?: (value: string) => void; size?`
- `Select`: `options: {value; label}[]; value?; onChange?: (e) => void; size?` (native select; read `e.target.value`)
- `Button`: `variant?; size?; icon?; onClick?; children`
- `Dialog`: `open; onClose?; title; width?; primaryAction?: {label; onClick?; disabled?}; secondaryAction?; children`
- `Input`: `placeholder?; value?; onChange?: (e) => void; autoFocus?; width?`
- `StatusFlag`: `label?: string; color?: string; size?: "sm"|"md"`
- `EmptyState`: `icon?; title; description?`
- `Icon`: `name; size?; color?`

- [ ] **Step 1: Write the failing ViewToolbar tests**

`src/views/ViewToolbar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Presentation } from '@/engine/types';
import { orderToValue, slugifyViewId, valueToOrder, ViewToolbar } from './ViewToolbar';

const presentation: Presentation = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
};

describe('slugifyViewId', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyViewId('My urgent work')).toBe('my-urgent-work');
  });
  it('strips leading and trailing separators', () => {
    expect(slugifyViewId('  Board: Q3! ')).toBe('board-q3');
  });
});

describe('order encoding', () => {
  it('round-trips known orderings', () => {
    expect(orderToValue({ field: 'due', dir: 'asc' })).toBe('due:asc');
    expect(valueToOrder('due:asc')).toEqual({ field: 'due', dir: 'asc' });
    expect(valueToOrder('modifiedAt:desc')).toEqual({ field: 'modifiedAt', dir: 'desc' });
  });
  it('falls back to modified desc for unknown orderings', () => {
    expect(orderToValue({ field: 'status', dir: 'desc' })).toBe('modifiedAt:desc');
  });
});

describe('ViewToolbar', () => {
  afterEach(cleanup);

  it('switching the segmented control reports a board presentation', () => {
    const onChange = vi.fn();
    render(
      <ViewToolbar presentation={presentation} onChange={onChange} onSaveView={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Board'));
    expect(onChange).toHaveBeenCalledWith({ ...presentation, type: 'board' });
  });

  it('changing group-by to none reports groupBy null', () => {
    const onChange = vi.fn();
    render(
      <ViewToolbar presentation={presentation} onChange={onChange} onSaveView={vi.fn()} />,
    );
    const groupSelect = screen.getByDisplayValue('Group: status');
    fireEvent.change(groupSelect, { target: { value: 'none' } });
    expect(onChange).toHaveBeenCalledWith({ ...presentation, groupBy: null });
  });

  it('save view dialog collects a name and calls onSaveView', () => {
    const onSaveView = vi.fn();
    render(
      <ViewToolbar presentation={presentation} onChange={vi.fn()} onSaveView={onSaveView} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.change(screen.getByPlaceholderText('View name'), {
      target: { value: 'My board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSaveView).toHaveBeenCalledWith('My board');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/views/ViewToolbar.test.tsx`
Expected: FAIL — `Cannot find module './ViewToolbar'`.

- [ ] **Step 3: Implement ViewToolbar.tsx**

`src/views/ViewToolbar.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import type { Presentation } from '@/engine/types';

export const GROUP_OPTIONS = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Group: status' },
  { value: 'priority', label: 'Group: priority' },
  { value: 'assignee', label: 'Group: assignee' },
  { value: 'estimate', label: 'Group: estimate' },
];

export const ORDER_OPTIONS = [
  { value: 'modifiedAt:desc', label: 'Last modified' },
  { value: 'modifiedAt:asc', label: 'Oldest modified' },
  { value: 'due:asc', label: 'Due date' },
  { value: 'priority:asc', label: 'Priority' },
];

export function orderToValue(orderBy: Presentation['orderBy']): string {
  const value = `${orderBy.field}:${orderBy.dir}`;
  return ORDER_OPTIONS.some((o) => o.value === value) ? value : 'modifiedAt:desc';
}

export function valueToOrder(value: string): Presentation['orderBy'] {
  const [field, dir] = value.split(':');
  return { field: field || 'modifiedAt', dir: dir === 'asc' ? 'asc' : 'desc' };
}

export function slugifyViewId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface ViewToolbarProps {
  presentation: Presentation;
  onChange: (presentation: Presentation) => void;
  onSaveView: (name: string) => void;
}

export function ViewToolbar({ presentation, onChange, onSaveView }: ViewToolbarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewName, setViewName] = useState('');

  const save = () => {
    const name = viewName.trim();
    if (!name) return;
    onSaveView(name);
    setDialogOpen(false);
    setViewName('');
  };

  return (
    <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
      <SegmentedControl
        size="sm"
        options={[
          { value: 'list', label: 'List', icon: 'list' },
          { value: 'board', label: 'Board', icon: 'columns-3' },
        ]}
        value={presentation.type}
        onChange={(value) =>
          onChange({ ...presentation, type: value as Presentation['type'] })
        }
      />
      <Select
        size="sm"
        options={GROUP_OPTIONS}
        value={presentation.groupBy ?? 'none'}
        onChange={(e) =>
          onChange({
            ...presentation,
            groupBy: e.target.value === 'none' ? null : e.target.value,
          })
        }
      />
      <Select
        size="sm"
        options={ORDER_OPTIONS}
        value={orderToValue(presentation.orderBy)}
        onChange={(e) => onChange({ ...presentation, orderBy: valueToOrder(e.target.value) })}
      />
      <span className="flex-1" />
      <Button variant="secondary" size="sm" icon="bookmark" onClick={() => setDialogOpen(true)}>
        Save view
      </Button>
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Save view"
        width={420}
        primaryAction={{ label: 'Save', onClick: save, disabled: viewName.trim() === '' }}
        secondaryAction={{ label: 'Cancel', onClick: () => setDialogOpen(false) }}
      >
        <Input
          autoFocus
          placeholder="View name"
          value={viewName}
          onChange={(e) => setViewName(e.target.value)}
          width="100%"
        />
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Run ViewToolbar tests to verify they pass**

Run: `pnpm vitest run src/views/ViewToolbar.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing ProjectPage test**

`src/pages/ProjectPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, ViewFile } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ProjectPage } from './ProjectPage';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    title: 'Untitled',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    ...partial,
  };
}

const space = mkEntry({
  path: 'spaces/product.md',
  filename: 'product.md',
  title: 'Product',
  type: 'Space',
  properties: { color: '#3D8BE8' },
});
const project = mkEntry({
  path: 'projects/foundations.md',
  filename: 'foundations.md',
  title: 'Foundations',
  type: 'Project',
  properties: { key: 'FLD' },
  relationships: { space: ['product'] },
});
const item = mkEntry({
  path: 'items/fld-1.md',
  filename: 'fld-1.md',
  title: 'Ship tokens',
  properties: { status: 'todo', key: 'FLD-1' },
  relationships: { project: ['foundations'] },
});

const boardView: ViewFile = {
  id: 'all-board',
  definition: {
    name: 'All board',
    icon: null,
    color: null,
    order: null,
    filters: null,
    presentation: {
      type: 'board',
      groupBy: 'status',
      orderBy: { field: 'modifiedAt', dir: 'desc' },
      visibleFields: ['key', 'status'],
    },
  },
};

describe('ProjectPage', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [space, project, item],
      views: [boardView],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'project', path: 'projects/foundations.md' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  afterEach(cleanup);

  it('renders breadcrumb and defaults to the list view', () => {
    render(<ProjectPage selection={{ kind: 'project', path: 'projects/foundations.md' }} />);
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByTestId('list-view')).toBeTruthy();
    expect(screen.queryByTestId('board-view')).toBeNull();
  });

  it('switching the toolbar flips list to board', () => {
    render(<ProjectPage selection={{ kind: 'project', path: 'projects/foundations.md' }} />);
    fireEvent.click(screen.getByText('Board'));
    expect(screen.getByTestId('board-view')).toBeTruthy();
    expect(screen.queryByTestId('list-view')).toBeNull();
  });

  it('a view selection uses the saved presentation', () => {
    render(<ProjectPage selection={{ kind: 'view', id: 'all-board' }} />);
    expect(screen.getByTestId('board-view')).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run src/pages/ProjectPage.test.tsx`
Expected: FAIL — `Cannot find module './ProjectPage'`.

- [ ] **Step 7: Write the ListView and BoardView placeholders**

`src/views/ListView.tsx`:

```tsx
import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';

export interface ListViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** project context enables the quick-add row; null outside a project */
  project: Entry | null;
}

// Placeholder — Task 20 replaces the body with the real grouped list.
// Keep the props above and data-testid="list-view" on the root element.
export function ListView({ entries }: ListViewProps) {
  return (
    <div data-testid="list-view" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      {entries.length === 0 ? (
        <EmptyState
          icon="list"
          title="No items"
          description="Items in this collection will appear here."
        />
      ) : (
        <div className="px-5 py-3 text-[13px] text-[var(--n-500)]">
          {entries.length} {entries.length === 1 ? 'item' : 'items'}
        </div>
      )}
    </div>
  );
}
```

`src/views/BoardView.tsx`:

```tsx
import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';

export interface BoardViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
}

// Placeholder — Task 21 replaces the body with the real kanban board.
// Keep the props above and data-testid="board-view" on the root element.
export function BoardView({ entries }: BoardViewProps) {
  return (
    <div data-testid="board-view" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      {entries.length === 0 ? (
        <EmptyState
          icon="columns-3"
          title="No items"
          description="Items in this collection will appear here."
        />
      ) : (
        <div className="px-5 py-3 text-[13px] text-[var(--n-500)]">
          {entries.length} {entries.length === 1 ? 'item' : 'items'}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Implement ProjectPage.tsx**

`src/pages/ProjectPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { resolveCollection } from '@/engine/collections';
import type { Presentation, Selection } from '@/engine/types';
import { serializeView } from '@/engine/views';
import { resolveTarget } from '@/engine/wikilink';
import { saveView } from '@/lib/ipc';
import { swatchColor } from '@/lib/swatch';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { BoardView } from '@/views/BoardView';
import { ListView } from '@/views/ListView';
import { slugifyViewId, ViewToolbar } from '@/views/ViewToolbar';

export type ProjectSelection = Extract<Selection, { kind: 'project' | 'view' }>;

export function ProjectPage({ selection }: { selection: ProjectSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);

  const collection = useMemo(
    () => resolveCollection(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  // Local presentation state, re-initialized when the selection target changes.
  const selectionKey = selection.kind === 'project' ? selection.path : selection.id;
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  useEffect(() => {
    setPresentation(collection.presentation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  const project =
    selection.kind === 'project'
      ? entries.find((e) => e.path === selection.path) ?? null
      : null;
  const spaceTarget = project?.relationships.space?.[0];
  const space = spaceTarget ? resolveTarget(spaceTarget, entries) : null;

  const handleSaveView = async (name: string) => {
    if (!vaultPath) return;
    const id = slugifyViewId(name) || 'view';
    const yaml = serializeView({
      name,
      icon: null,
      color: null,
      order: null,
      filters: null,
      presentation,
    });
    await saveView(vaultPath, id, yaml);
    await rescan(); // the watcher rescan also picks the new view up for the sidebar
    toast(`View "${name}" saved`);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-none px-5 pt-3.5">
        <div className="mb-2.5 flex min-w-0 items-center gap-2">
          {project ? (
            <>
              {space ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate({ kind: 'space', path: space.path })}
                    className="inline-flex items-center gap-[7px] border-0 bg-transparent text-[15px] font-medium text-[var(--n-700)] hover:text-[var(--n-900)]"
                  >
                    <span
                      className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] text-[10px] font-bold text-white"
                      style={{ background: swatchColor(space.properties.color) }}
                    >
                      {space.title.charAt(0).toUpperCase()}
                    </span>
                    {space.title}
                  </button>
                  <span className="px-0.5 text-[14px] text-[var(--n-400)]">/</span>
                </>
              ) : null}
              <Icon name="folder-kanban" size={16} color="var(--n-600)" />
              <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">
                {project.title}
              </h1>
            </>
          ) : (
            <>
              <Icon name="layout-list" size={16} color="var(--n-600)" />
              <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">
                {collection.title}
              </h1>
            </>
          )}
        </div>
      </div>
      <ViewToolbar
        presentation={presentation}
        onChange={setPresentation}
        onSaveView={handleSaveView}
      />
      {presentation.type === 'board' ? (
        <BoardView entries={collection.entries} presentation={presentation} schema={schema} />
      ) : (
        <ListView entries={collection.entries} presentation={presentation} schema={schema} project={project} />
      )}
    </div>
  );
}
```

- [ ] **Step 9: Run the ProjectPage test to verify it passes**

Run: `pnpm vitest run src/pages/ProjectPage.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 10: Implement SpacePage.tsx**

`src/pages/SpacePage.tsx` (compositional — verified in Step 12):

```tsx
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusFlag } from '@/components/ui/StatusFlag';
import { resolveTarget } from '@/engine/wikilink';
import { swatchColor } from '@/lib/swatch';
import { ProjectCard } from '@/pages/HomePage';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export function SpacePage({ path }: { path: string }) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();

  const space = entries.find((e) => e.path === path) ?? null;
  const projects = useMemo(
    () =>
      entries
        .filter(
          (e) =>
            e.type === 'Project' &&
            (e.relationships.space ?? []).some((t) => resolveTarget(t, entries)?.path === path),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries, path],
  );
  const statuses = schema.statusSetForSpace(path);

  if (!space) {
    return (
      <EmptyState
        icon="folder"
        title="Space not found"
        description="This space is not in the current vault."
      />
    );
  }

  const description =
    typeof space.properties.description === 'string'
      ? space.properties.description
      : space.snippet;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--n-0)]">
      <div className="mx-auto max-w-[1080px] px-8 pb-14 pt-7">
        <div className="mb-1.5 flex items-center gap-3">
          <span
            className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] text-[15px] font-bold text-white"
            style={{ background: swatchColor(space.properties.color) }}
          >
            {space.title.charAt(0).toUpperCase()}
          </span>
          <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.01em]">
            {space.title}
          </h1>
        </div>
        {description ? (
          <p className="mb-3 ml-[46px] mt-0 max-w-[640px] text-[13px] leading-[19px] text-[var(--n-600)]">
            {description}
          </p>
        ) : null}
        <div className="mb-[26px] ml-[46px] flex flex-wrap items-center gap-1.5">
          {statuses.map((status) => (
            <StatusFlag
              key={status.id}
              label={status.label}
              color={status.color ? swatchColor(status.color) : undefined}
              size="sm"
            />
          ))}
        </div>
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Projects</h2>
          <span className="text-[12px] text-[var(--n-500)]">{projects.length}</span>
        </div>
        {projects.length === 0 ? (
          <EmptyState
            icon="folder-kanban"
            title="No projects yet"
            description="Projects in this space will appear here."
          />
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {projects.map((project) => (
              <ProjectCard key={project.path} project={project} subtitle={space.title} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 11: Mount the pages in the canvas outlet**

Edit `src/App.tsx` — replace:

```tsx
import { HomePage } from '@/pages/HomePage';
```

with:

```tsx
import { HomePage } from '@/pages/HomePage';
import { ProjectPage } from '@/pages/ProjectPage';
import { SpacePage } from '@/pages/SpacePage';
```

then replace:

```tsx
    case 'space': return <CanvasPlaceholder label="Space" />;
```

with:

```tsx
    case 'space': return <SpacePage path={selection.path} />;
```

then replace:

```tsx
    case 'project': return <CanvasPlaceholder label="Project" />;
    case 'view': return <CanvasPlaceholder label="View" />;
```

with:

```tsx
    case 'project': return <ProjectPage selection={selection} />;
    case 'view': return <ProjectPage selection={selection} />;
```

(`CanvasPlaceholder` remains in use for `settings` until Task 23.)

- [ ] **Step 12: Verify in the browser and run the full suite**

Run: `pnpm dev`
Expected: clicking a space in the sidebar or home grid shows the space header (34px letter swatch in the space color, title, description), the space's status set as colored flag chips, and the projects grid; clicking a project shows the `Space / Project` breadcrumb, the toolbar (List/Board segmented control, group-by and order selects, "Save view"), and the placeholder list body; switching to Board swaps the placeholder; "Save view" opens a dialog, and saving writes `views/<slug>.yml` (visible in `window.__cerebroMockFs` in browser mode) and raises a toast. Selecting the saved view in the sidebar opens it with its saved presentation.

Run: `pnpm vitest run src`
Expected: PASS — all suites.

- [ ] **Step 13: Commit**

```sh
git add src/views/ViewToolbar.tsx src/views/ViewToolbar.test.tsx src/views/ListView.tsx src/views/BoardView.tsx src/pages/SpacePage.tsx src/pages/ProjectPage.tsx src/pages/ProjectPage.test.tsx src/App.tsx
git commit -m "feat: add space and project pages with view toolbar"
```

### Task 20: ListView — grouped sections, field chips, quick-add

**Files:**
- Create: `src/lib/slug.ts`
- Create: `src/lib/slug.test.ts`
- Create: `src/test/factories.ts`
- Create: `src/views/FieldChip.tsx`
- Create: `src/views/ListView.tsx`
- Test: `src/views/ListView.test.tsx`

**Component contract (consumed by ProjectPage/SpacePage from Task 19):**

```ts
export interface ListViewProps {
  entries: Entry[];          // already filtered by the collections layer
  presentation: Presentation;
  schema: Schema;            // pass useSchema() down from the page
  project: Entry | null;     // project context; enables the quick-add row when non-null
}
```

**DS prop APIs relied on** (from `docs/Cerebro Design System/components/*/`):

```ts
// display/Avatar.d.ts
export interface AvatarProps { name: string; size?: number; src?: string; style?: React.CSSProperties; className?: string }
// core/Icon.d.ts
export interface IconProps { name: string; size?: number; strokeWidth?: number; color?: string; style?: React.CSSProperties; className?: string }
```

Anatomy mirrors the prototype's project items list (`CerebroApp.dc.html`, `data-screen-label="Project"`, `wlList` block): 36px sticky group header on `--n-25` with a status dot / label / mono count, rows with mono key (52px), type icon, title, right-aligned field chips, and a ghost "+ Add item" row per group.

- [ ] **Step 1: Write the failing tests**

`src/lib/slug.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { slugify } from '@/lib/slug';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Ship the fix!')).toBe('ship-the-fix');
  });
  it('strips diacritics and trims dashes', () => {
    expect(slugify('  Émigré notes ')).toBe('emigre-notes');
  });
  it('collapses runs of separators', () => {
    expect(slugify('A  --  B')).toBe('a-b');
  });
});
```

`src/test/factories.ts` (shared fixture used by Tasks 20–23 tests):

```ts
import type { Entry } from '@/engine/types';

export function makeEntry(partial: Partial<Entry> & { path: string }): Entry {
  const filename = partial.path.split('/').pop() ?? partial.path;
  return {
    filename,
    title: filename.replace(/\.md$/, ''),
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T09:00:00Z',
    modifiedAt: '2026-07-02T09:00:00Z',
    parseError: null,
    ...partial,
  };
}

/** Minimal Meridian-style vault: type notes, one space (todo/doing/done), one project (FLD), one person, three items. */
export function fixtureVault(): Entry[] {
  return [
    makeEntry({
      path: 'type/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        icon: 'circle-check',
        color: 'var(--cortex-500)',
        fields: {
          status: { kind: 'status' },
          priority: {
            kind: 'select',
            options: [{ id: 'high', color: '#DE8F0A' }, { id: 'low', color: '#A8AFC2' }],
          },
          assignee: { kind: 'person' },
          due: { kind: 'date' },
          project: { kind: 'relation', target: 'Project' },
        },
      } as unknown as Entry['properties'],
    }),
    makeEntry({ path: 'type/project.md', title: 'Project', type: 'Type', properties: { icon: 'folder', color: 'var(--n-600)' } }),
    makeEntry({ path: 'type/space.md', title: 'Space', type: 'Type', properties: { icon: 'box', color: 'var(--n-600)' } }),
    makeEntry({ path: 'type/person.md', title: 'Person', type: 'Type', properties: { icon: 'user', color: 'var(--n-600)' } }),
    makeEntry({
      path: 'spaces/field-platform.md',
      title: 'Field platform',
      type: 'Space',
      properties: {
        color: 'var(--swatch-teal)',
        statuses: [
          { id: 'todo', group: 'active', color: 'var(--n-500)', hollow: true },
          { id: 'doing', group: 'active', color: 'var(--warn-500)' },
          { id: 'done', group: 'done', color: 'var(--success-500)' },
        ],
      } as unknown as Entry['properties'],
    }),
    makeEntry({
      path: 'projects/onboarding.md',
      title: 'Guided onboarding',
      type: 'Project',
      properties: { key: 'FLD' },
      relationships: { space: ['field-platform'] },
    }),
    makeEntry({ path: 'people/ana-rios.md', title: 'Ana Rios', type: 'Person' }),
    makeEntry({
      path: 'items/fld-1.md',
      title: 'Design first-run flow',
      type: 'Work item',
      properties: { key: 'FLD-1', status: 'todo', priority: 'high', channel: 'field-ops' },
      relationships: { project: ['onboarding'], assignee: ['ana-rios'] },
    }),
    makeEntry({
      path: 'items/fld-2.md',
      title: 'Wire field sync banner',
      type: 'Work item',
      properties: { key: 'FLD-2', status: 'doing', priority: 'low' },
      relationships: { project: ['onboarding'] },
    }),
    makeEntry({ path: 'items/broken.md', title: 'broken', type: null, parseError: 'bad yaml: line 2' }),
  ];
}
```

`src/views/ListView.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListView } from '@/views/ListView';
import { FieldChip } from '@/views/FieldChip';
import { buildSchema } from '@/engine/schema';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';
import type { Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['status', 'priority', 'assignee'],
};

function setup(overrides: Partial<ReturnType<typeof useVaultStore.getState>> = {}) {
  const entries = fixtureVault();
  useVaultStore.setState({ entries, ...overrides });
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.path.startsWith('items/'));
  const project = entries.find((e) => e.path === 'projects/onboarding.md')!;
  render(<ListView entries={items} presentation={presentation} schema={schema} project={project} />);
}

afterEach(cleanup);

describe('ListView', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  it('renders group headers in the schema status order, including empty groups', () => {
    setup();
    const labels = screen.getAllByTestId('group-header').map((h) => h.textContent ?? '');
    expect(labels[0]).toContain('Todo');
    expect(labels[1]).toContain('Doing');
    expect(labels[2]).toContain('Done'); // empty group still renders, proving schema order
  });

  it('renders a warning row for entries with a parse error', () => {
    setup();
    expect(screen.getByText('Cannot parse')).toBeTruthy();
    expect(screen.getByText('broken.md')).toBeTruthy();
  });

  it('quick-add creates an item with the group field value pre-set', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/ship-the-fix.md');
    setup({ createItem });
    const doingHeader = screen
      .getAllByTestId('group-header')
      .find((h) => h.textContent?.includes('Doing'))!;
    const section = doingHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), 'Ship the fix{Enter}');
    expect(createItem).toHaveBeenCalledWith({
      folder: 'items',
      slug: 'ship-the-fix',
      frontmatter: {
        type: 'Work item',
        key: 'FLD-3',
        project: '[[onboarding]]',
        status: 'doing',
      },
    });
  });

  it('quick-add cancels on Escape', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn();
    setup({ createItem });
    const todoHeader = screen
      .getAllByTestId('group-header')
      .find((h) => h.textContent?.includes('Todo'))!;
    const section = todoHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), 'never{Escape}');
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(createItem).not.toHaveBeenCalled();
  });
});

describe('FieldChip', () => {
  afterEach(cleanup);

  it('renders ghost values with dashed muted styling', () => {
    const { container } = render(
      <FieldChip resolved={{ def: null, raw: 'weird', display: 'weird', color: null, ghost: true }} />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('border-dashed');
  });

  it('renders nothing for empty values', () => {
    const { container } = render(
      <FieldChip resolved={{ def: null, raw: null, display: '', color: null, ghost: false }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/slug.test.ts src/views/ListView.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/slug'` / `Cannot find module '@/views/ListView'` (files do not exist yet).

- [ ] **Step 3: Write `src/lib/slug.ts`**

```ts
/** Filename slug from a display title: lowercase, ASCII, dash-separated. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 4: Write `src/views/FieldChip.tsx`**

```tsx
import { Avatar } from '@/components/ui/Avatar';
import type { ResolvedField } from '@/engine/types';

function optionHollow(resolved: ResolvedField): boolean {
  const options = resolved.def?.options;
  if (!options) return false;
  return options.some((o) => o.id === resolved.raw && o.hollow === true);
}

/** One right-aligned value chip in a list row, rendered per ResolvedField kind. */
export function FieldChip({ resolved }: { resolved: ResolvedField }) {
  if (resolved.display === '') return null;
  const kind = resolved.def?.kind ?? 'text';

  if (resolved.ghost) {
    return (
      <span className="inline-flex flex-none items-center rounded-md border border-dashed border-[var(--n-300)] px-1.5 py-0.5 text-[11px] text-[var(--n-400)]">
        {resolved.display}
      </span>
    );
  }
  if (kind === 'person') {
    return (
      <span className="inline-flex flex-none items-center gap-1.5 text-[12px] text-[var(--n-700)]">
        <Avatar name={resolved.display} size={20} />
        {resolved.display}
      </span>
    );
  }
  if (kind === 'date' || kind === 'daterange') {
    return (
      <span className="inline-flex flex-none [font-family:var(--font-mono)] text-[11px] text-[var(--n-500)]">
        {resolved.display}
      </span>
    );
  }
  if (kind === 'status' || kind === 'select' || kind === 'multiselect') {
    const color = resolved.color ?? 'var(--n-400)';
    const hollow = optionHollow(resolved);
    return (
      <span className="inline-flex flex-none items-center gap-1.5 text-[12px] text-[var(--n-700)]">
        <span
          className="box-border h-[9px] w-[9px] flex-none rounded-full"
          style={hollow ? { border: `1.5px solid ${color}` } : { background: color, border: `1.5px solid ${color}` }}
        />
        {resolved.display}
      </span>
    );
  }
  return <span className="inline-flex flex-none text-[12px] text-[var(--n-600)]">{resolved.display}</span>;
}
```

- [ ] **Step 5: Write `src/views/ListView.tsx`**

```tsx
import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FieldChip } from '@/views/FieldChip';
import { groupEntries } from '@/engine/grouping';
import { nextItemKey } from '@/engine/itemKeys';
import { formatWikilink } from '@/engine/wikilink';
import { slugify } from '@/lib/slug';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { Entry, Group, Presentation, Schema } from '@/engine/types';

export interface ListViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** project context enables the quick-add row; pass null outside a project */
  project: Entry | null;
}

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

function QuickAddRow({ group, groupBy, project }: { group: Group; groupBy: string | null; project: Entry }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const createItem = useVaultStore((s) => s.createItem);
  const allEntries = useVaultStore((s) => s.entries);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    const prefix = typeof project.properties.key === 'string' ? project.properties.key : 'WRK';
    const frontmatter: Record<string, unknown> = {
      type: 'Work item',
      key: nextItemKey(prefix, allEntries),
      project: formatWikilink(pathStem(project.path)),
    };
    if (groupBy && group.key !== '__none__') frontmatter[groupBy] = group.key;
    await createItem({ folder: 'items', slug: slugify(trimmed), frontmatter });
    setTitle('');
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-[34px] w-full items-center gap-2 border-b border-[var(--n-100)] px-5 text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-25)] hover:text-[var(--n-700)]"
      >
        <Icon name="plus" size={13} />
        Add item
      </button>
    );
  }
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-[var(--n-100)] px-5">
      <Icon name="plus" size={13} color="var(--n-400)" />
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            setTitle('');
            setEditing(false);
          }
        }}
        placeholder="Item title — Enter to create"
        aria-label={`New item in ${group.label}`}
        className="h-6 flex-1 border-none bg-transparent text-[13px] text-[var(--n-900)] outline-none"
      />
    </div>
  );
}

function ListRow({ entry, presentation, schema }: { entry: Entry; presentation: Presentation; schema: Schema }) {
  const openDetail = useUiStore((s) => s.openDetail);
  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';

  if (entry.parseError) {
    return (
      <div
        role="row"
        onClick={() => openDetail(entry.path)}
        className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] px-5 hover:bg-[var(--n-50)]"
      >
        <span className="w-[52px] flex-none" />
        <span className="inline-flex flex-none text-[var(--warn-500)]">
          <Icon name="triangle-alert" size={14} />
        </span>
        <span className="truncate text-[13px] text-[var(--n-700)]">{entry.filename}</span>
        <span className="inline-flex flex-none items-center rounded-md border border-[var(--warn-500)] px-1.5 py-0.5 text-[11px] text-[var(--warn-500)]">
          Cannot parse
        </span>
      </div>
    );
  }

  return (
    <div
      role="row"
      onClick={() => openDetail(entry.path)}
      className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] px-5 hover:bg-[var(--n-50)]"
    >
      <span className="w-[52px] flex-none [font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">{key}</span>
      <span title={entry.type ?? undefined} className="inline-flex flex-none" style={{ color: typeDef?.color ?? 'var(--n-400)' }}>
        <Icon name={typeDef?.icon ?? 'file-text'} size={14} />
      </span>
      <span className="truncate text-[13px] text-[var(--n-900)]">{entry.title}</span>
      <span className="flex-1" />
      {presentation.visibleFields
        .filter((f) => f !== 'key')
        .map((f) => (
          <FieldChip key={f} resolved={schema.resolveField(entry, f)} />
        ))}
    </div>
  );
}

export function ListView({ entries, presentation, schema, project }: ListViewProps) {
  const groupBy = presentation.groupBy;
  const groups: Group[] = groupBy
    ? groupEntries(entries, groupBy, schema)
    : [{ key: '', label: 'All items', color: null, ghost: false, entries }];

  return (
    <div className="min-w-[720px]">
      {groups.map((g) => (
        <section key={g.key || g.label}>
          <header
            data-testid="group-header"
            className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-[var(--n-100)] bg-[var(--n-25)] px-5"
          >
            <span
              className="box-border h-[11px] w-[11px] rounded-full"
              style={
                g.ghost || !g.color
                  ? { border: '1.5px solid var(--n-400)' }
                  : { background: g.color, border: `1.5px solid ${g.color}` }
              }
            />
            <span className="text-[12.5px] font-semibold text-[var(--n-800)]">{g.label}</span>
            <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">{g.entries.length}</span>
          </header>
          {g.entries.map((e) => (
            <ListRow key={e.path} entry={e} presentation={presentation} schema={schema} />
          ))}
          {project && <QuickAddRow group={g} groupBy={groupBy} project={project} />}
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/slug.test.ts src/views/ListView.test.tsx`
Expected: PASS (all slugify, ListView, and FieldChip tests green).

- [ ] **Step 7: Commit**

```
git add src/lib/slug.ts src/lib/slug.test.ts src/test/factories.ts src/views/FieldChip.tsx src/views/ListView.tsx src/views/ListView.test.tsx
git commit -m "feat: add grouped list view with field chips and quick-add"
```

---

### Task 21: BoardView — columns, cards, dnd-kit drag to move

**Files:**
- Create: `src/views/BoardView.tsx`
- Test: `src/views/BoardView.test.tsx`

**Component contract (consumed by ProjectPage from Task 19):**

```ts
export interface BoardViewProps { entries: Entry[]; presentation: Presentation; schema: Schema }
```

Anatomy mirrors the prototype board (`data-screen-label="Project"`, `wlBoard` block): `--n-25` canvas, 280px columns with dot / label / mono count headers, cards with a 3px colored left edge (group color), mono key, title, priority flag, assignee avatar. Entries with `parseError` are excluded from the board; a muted footer notes how many were hidden. The drop handler is exported as a pure function so it can be unit-tested without simulating pointer events.

**DS prop APIs relied on:**

```ts
// display/StatusFlag.d.ts — used bare (glyph only) for priority
export interface StatusFlagProps { status?: string; label?: string; color?: string; bare?: boolean; size?: "sm" | "md"; ... }
// display/Avatar.d.ts
export interface AvatarProps { name: string; size?: number; ... }
```

- [ ] **Step 1: Write the failing test**

`src/views/BoardView.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { BoardView, handleDragEnd, NO_VALUE_COLUMN_ID } from '@/views/BoardView';
import { buildSchema } from '@/engine/schema';
import { groupEntries } from '@/engine/grouping';
import { fixtureVault } from '@/test/factories';
import type { Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'board',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['status', 'priority', 'assignee'],
};

afterEach(cleanup);

describe('BoardView', () => {
  it('renders one column per group and a muted footer counting unparseable entries', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('items/'));
    render(<BoardView entries={items} presentation={presentation} schema={schema} />);
    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy(); // empty column still renders
    expect(screen.getByText('1 unparseable item hidden')).toBeTruthy();
    expect(screen.queryByText('broken.md')).toBeNull();
  });
});

describe('handleDragEnd', () => {
  const entries = fixtureVault();
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.path.startsWith('items/') && e.path !== 'items/broken.md');
  const groups = groupEntries(items, 'status', schema);

  it('patches the dragged entry frontmatter and toasts the target label', () => {
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = { active: { id: 'items/fld-1.md' }, over: { id: 'doing' } } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('items/fld-1.md', { status: 'doing' });
    expect(toast).toHaveBeenCalledWith('Moved to Doing');
  });

  it('is a no-op when dropped on the source column', () => {
    const patchFrontmatter = vi.fn();
    const toast = vi.fn();
    const event = { active: { id: 'items/fld-1.md' }, over: { id: 'todo' } } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, patchFrontmatter, toast });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('writes null when dropped on the no-value column', () => {
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = {
      active: { id: 'items/fld-1.md' },
      over: { id: NO_VALUE_COLUMN_ID },
    } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('items/fld-1.md', { status: null });
  });

  it('is a no-op when dropped outside any column', () => {
    const patchFrontmatter = vi.fn();
    const event = { active: { id: 'items/fld-1.md' }, over: null } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, patchFrontmatter, toast: vi.fn() });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
});
```

Note: `groupEntries` (Task 14) returns the trailing no-value group with `key: '__none__'` (pinned in the spine contracts); if the fixture set produces no such group, append a hand-built `{ key: '__none__', label: 'No status', color: null, ghost: true, entries: [] }` group for the `over: NO_VALUE_COLUMN_ID` test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/views/BoardView.test.tsx`
Expected: FAIL — `Cannot find module '@/views/BoardView'`.

- [ ] **Step 3: Write `src/views/BoardView.tsx` — drop handler and card**

```tsx
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { Avatar } from '@/components/ui/Avatar';
import { StatusFlag } from '@/components/ui/StatusFlag';
import { groupEntries } from '@/engine/grouping';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry, Group, Presentation, Schema } from '@/engine/types';

export interface BoardViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
}

/** Droppable id used for the trailing "No <field>" group (dnd-kit ids must be non-empty). */
export const NO_VALUE_COLUMN_ID = '::none';

export function handleDragEnd(
  event: DragEndEvent,
  args: {
    groupBy: string;
    groups: Group[];
    patchFrontmatter: (path: string, patch: Record<string, unknown>) => Promise<void>;
    toast: (message: string) => void;
  },
): void {
  const { active, over } = event;
  if (!over) return;
  const path = String(active.id);
  const overKey = String(over.id) === NO_VALUE_COLUMN_ID ? '' : String(over.id);
  const target = args.groups.find((g) => g.key === overKey);
  if (!target) return;
  const source = args.groups.find((g) => g.entries.some((e) => e.path === path));
  if (source && source.key === target.key) return;
  void args.patchFrontmatter(path, { [args.groupBy]: target.key === '__none__' ? null : target.key });
  args.toast(`Moved to ${target.label}`);
}

function BoardCard({ entry, group, schema }: { entry: Entry; group: Group; schema: Schema }) {
  const openDetail = useUiStore((s) => s.openDetail);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: entry.path });
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';
  const priority = schema.resolveField(entry, 'priority');
  const assignee = schema.resolveField(entry, 'assignee');

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => openDetail(entry.path)}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        borderLeft: `3px solid ${group.ghost || !group.color ? 'var(--n-300)' : group.color}`,
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 20 : undefined,
      }}
      className="relative cursor-pointer rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-[11px] py-[9px] shadow-[var(--shadow-xs)] hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)]"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="[font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">{key}</span>
      </div>
      <div className="mb-2 text-[13px] font-medium leading-[18px] text-[var(--n-900)]">{entry.title}</div>
      <div className="flex items-center gap-[7px]">
        {priority.display !== '' && (
          <span title={`Priority: ${priority.display}`} className="inline-flex">
            <StatusFlag bare size="sm" label={priority.display} color={priority.color ?? 'var(--n-400)'} />
          </span>
        )}
        <span className="flex-1" />
        {assignee.display !== '' && <Avatar name={assignee.display} size={18} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Append column and board components to `src/views/BoardView.tsx`**

```tsx
function BoardColumn({ group, schema }: { group: Group; schema: Schema }) {
  const droppableId = group.key === '__none__' ? NO_VALUE_COLUMN_ID : group.key;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  return (
    <div className="w-[280px] flex-none">
      <div className="flex items-center gap-[7px] px-1 pb-[9px]">
        <span
          className="box-border h-2.5 w-2.5 rounded-full"
          style={
            group.ghost || !group.color
              ? { border: '1.5px solid var(--n-400)' }
              : { background: group.color, border: `1.5px solid ${group.color}` }
          }
        />
        <span className="text-[12.5px] font-semibold text-[var(--n-800)]">{group.label}</span>
        <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">{group.entries.length}</span>
      </div>
      <div
        ref={setNodeRef}
        data-testid={`board-column-${droppableId}`}
        className="flex min-h-[60px] flex-col gap-2 rounded-[10px] p-0.5"
        style={{ background: isOver ? 'var(--cortex-50)' : 'transparent' }}
      >
        {group.entries.map((e) => (
          <BoardCard key={e.path} entry={e} group={group} schema={schema} />
        ))}
      </div>
    </div>
  );
}

export function BoardView({ entries, presentation, schema }: BoardViewProps) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const toast = useUiStore((s) => s.toast);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const groupBy = presentation.groupBy ?? 'status';
  const parseable = entries.filter((e) => e.parseError === null);
  const hiddenCount = entries.length - parseable.length;
  const groups = groupEntries(parseable, groupBy, schema);

  return (
    <div className="box-border min-h-full bg-[var(--n-25)] px-5 py-4">
      <DndContext
        sensors={sensors}
        onDragEnd={(event) => handleDragEnd(event, { groupBy, groups, patchFrontmatter, toast })}
      >
        <div className="flex items-start gap-3 overflow-x-auto">
          {groups.map((g) => (
            <BoardColumn key={g.key || g.label} group={g} schema={schema} />
          ))}
        </div>
      </DndContext>
      {hiddenCount > 0 && (
        <div className="pt-3 text-[12px] text-[var(--n-400)]">
          {hiddenCount} unparseable item{hiddenCount === 1 ? '' : 's'} hidden
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/views/BoardView.test.tsx`
Expected: PASS (columns render, footer counts hidden entries, all four `handleDragEnd` cases green).

- [ ] **Step 6: Verify drag in the browser**

Run: `pnpm dev` — open a project, switch to Board.
Expected: dragging a card to another column moves it, the frontmatter of the item file changes in the mock FS, and a "Moved to <label>" toast appears (toast host arrives in Task 23; until then the store records it — verify via `useUiStore.getState().toasts` in devtools console if needed).

- [ ] **Step 7: Commit**

```
git add src/views/BoardView.tsx src/views/BoardView.test.tsx
git commit -m "feat: add board view with drag-to-move between columns"
```

---

### Task 22: DetailPanel — schema-driven field editors, popovers, description, rename

**Files:**
- Create: `src/detail/FieldPopover.tsx`
- Create: `src/detail/FieldEditor.tsx`
- Create: `src/detail/DetailPanel.tsx`
- Modify: `src/styles/index.css` (panel-in keyframes)
- Modify: `src/App.tsx` (mount the panel)
- Test: `src/detail/DetailPanel.test.tsx`

Anatomy mirrors the prototype item panel (`data-screen-label="Item panel"` / `"Detail panel"` and `"Field editor popover"` in `CerebroApp.dc.html`): 420px right aside sliding in with translateX+fade (180ms `cubic-bezier(.2,.6,.2,1)`), header with type icon + mono key + close, large inline-rename title, 96px field labels in `--n-500`, anchored option popovers with colored dots and a search input for entity pickers, description textarea, mono created/modified footer.

**DS prop APIs relied on:**

```ts
// core/IconButton.d.ts
export interface IconButtonProps { icon: string; label: string; size?: "sm" | "md" | "lg"; onClick?: () => void; ... }
// core/Input.d.ts
export interface InputProps { icon?: string; placeholder?: string; value?: string; onChange?: (e: any) => void; size?: "sm" | "md" | "lg"; autoFocus?: boolean; width?: number | string; ... }
// core/Switch.d.ts
export interface SwitchProps { checked?: boolean; onChange?: (checked: boolean) => void; label?: React.ReactNode; ... }
```

- [ ] **Step 1: Write the failing test**

`src/detail/DetailPanel.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '@/detail/DetailPanel';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault } from '@/test/factories';

vi.mock('@/lib/ipc', () => ({
  readNote: vi.fn().mockResolvedValue('Existing body'),
  saveNote: vi.fn().mockResolvedValue(undefined),
  setNoteTitle: vi.fn().mockResolvedValue(undefined),
  pickVault: vi.fn(),
  getLastVault: vi.fn(),
  scanVault: vi.fn().mockResolvedValue([]),
  updateFrontmatter: vi.fn().mockResolvedValue(undefined),
  createNote: vi.fn(),
  listViews: vi.fn().mockResolvedValue([]),
  saveView: vi.fn(),
  startWatcher: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

describe('DetailPanel', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
    useUiStore.setState({ detailPath: 'items/fld-1.md' });
  });

  it('writes a frontmatter patch when a status option is picked', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ patchFrontmatter });
    render(<DetailPanel />);
    await user.click(screen.getByRole('button', { name: 'Todo' }));
    await user.click(screen.getByRole('option', { name: 'Doing' }));
    expect(patchFrontmatter).toHaveBeenCalledWith('items/fld-1.md', { status: 'doing' });
  });

  it('shows undeclared frontmatter keys as advisory text', () => {
    render(<DetailPanel />);
    expect(screen.getByText('Channel')).toBeTruthy();
    expect(screen.getByText('field-ops')).toBeTruthy();
  });

  it('closes on Escape', () => {
    render(<DetailPanel />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('renders nothing when no detail path is open', () => {
    useUiStore.setState({ detailPath: null });
    const { container } = render(<DetailPanel />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/detail/DetailPanel.test.tsx`
Expected: FAIL — `Cannot find module '@/detail/DetailPanel'`.

- [ ] **Step 3: Write `src/detail/FieldPopover.tsx`**

```tsx
import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';

export interface FieldPopoverOption {
  id: string;
  label: string;
  color: string | null;
  hollow?: boolean;
}

export interface FieldPopoverProps {
  options: FieldPopoverOption[];
  activeId?: string | null;
  /** show a title-filter input (person/relation pickers) */
  searchable?: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Anchored option popover; render inside a `relative` wrapper next to its trigger. */
export function FieldPopover({ options, activeId, searchable, onPick, onClose }: FieldPopoverProps) {
  const [query, setQuery] = useState('');
  const visible =
    query.trim() === ''
      ? options
      : options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <>
      <button
        type="button"
        aria-label="Close popover"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-transparent"
      />
      <div
        role="listbox"
        className="absolute left-0 top-full z-50 mt-1 w-60 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]"
      >
        {searchable && (
          <div className="pb-1.5">
            <Input autoFocus size="sm" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} width="100%" />
          </div>
        )}
        <div className="max-h-[264px] overflow-y-auto">
          {visible.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === activeId}
              onClick={() => {
                onPick(o.id);
                onClose();
              }}
              className="flex w-full items-center gap-2 rounded-[7px] px-2 py-[7px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
            >
              <span
                className="box-border h-2 w-2 flex-none rounded-full"
                style={
                  o.hollow || !o.color
                    ? { border: `1.5px solid ${o.color ?? 'var(--n-400)'}` }
                    : { background: o.color }
                }
              />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.id === activeId && <Icon name="check" size={14} color="var(--cortex-600)" />}
            </button>
          ))}
          {visible.length === 0 && <div className="p-2 text-[12px] text-[var(--n-400)]">No matches</div>}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Write `src/detail/FieldEditor.tsx`**

```tsx
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { FieldPopover } from '@/detail/FieldPopover';
import type { FieldPopoverOption } from '@/detail/FieldPopover';
import { formatWikilink } from '@/engine/wikilink';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry, FieldDef, Schema } from '@/engine/types';

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

export const humanize = (s: string) => {
  const t = s.replace(/[-_]/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const dateInputClass =
  'h-[26px] rounded-md border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 [font-family:var(--font-mono)] text-[12px] text-[var(--n-800)] outline-none focus:border-[var(--cortex-500)] focus:shadow-[0_0_0_3px_var(--cortex-100)]';

export interface FieldEditorProps {
  entry: Entry;
  def: FieldDef;
  schema: Schema;
}

export function FieldEditor({ entry, def, schema }: FieldEditorProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const entries = useVaultStore((s) => s.entries);
  const resolved = schema.resolveField(entry, def.name);

  const patch = (value: unknown) => void patchFrontmatter(entry.path, { [def.name]: value });

  if (def.kind === 'status' || def.kind === 'select' || def.kind === 'multiselect') {
    const options: FieldPopoverOption[] =
      def.kind === 'status'
        ? schema
            .statusSetForSpace(schema.spaceForEntry(entry)?.path ?? null)
            .map((s) => ({ id: s.id, label: s.label, color: s.color, hollow: s.hollow }))
        : (def.options ?? []).map((o) => ({ id: o.id, label: o.label, color: o.color, hollow: o.hollow }));
    return (
      <span className="relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-[3px] text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
        >
          <span
            className="box-border h-[9px] w-[9px] flex-none rounded-full"
            style={{ background: resolved.color ?? 'var(--n-300)' }}
          />
          {resolved.display === '' ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          <FieldPopover
            options={options}
            activeId={typeof resolved.raw === 'string' ? resolved.raw : null}
            onPick={(id) => patch(id)}
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    );
  }

  if (def.kind === 'person' || def.kind === 'relation') {
    const targetType = def.kind === 'person' ? 'Person' : (def.target ?? '');
    const options: FieldPopoverOption[] = entries
      .filter((e) => e.type === targetType)
      .map((c) => ({ id: pathStem(c.path), label: c.title, color: null }));
    return (
      <span className="relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-[7px] rounded-md px-2 py-[3px] text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
        >
          {def.kind === 'person' && resolved.display !== '' && <Avatar name={resolved.display} size={20} />}
          {resolved.display === '' ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          <FieldPopover
            searchable
            options={options}
            onPick={(id) => patch(formatWikilink(id))}
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    );
  }

  if (def.kind === 'date') {
    const value = typeof resolved.raw === 'string' ? resolved.raw : '';
    return (
      <input
        type="date"
        aria-label={humanize(def.name)}
        value={value}
        onChange={(e) => patch(e.target.value === '' ? null : e.target.value)}
        className={dateInputClass}
      />
    );
  }

  if (def.kind === 'daterange') {
    const raw = (resolved.raw ?? {}) as { start?: string; end?: string };
    const set = (part: 'start' | 'end') => (e: ChangeEvent<HTMLInputElement>) =>
      patch({ start: raw.start ?? null, end: raw.end ?? null, [part]: e.target.value || null });
    return (
      <span className="inline-flex items-center gap-1.5">
        <input type="date" aria-label={`${humanize(def.name)} start`} value={raw.start ?? ''} onChange={set('start')} className={dateInputClass} />
        <span className="text-[var(--n-400)]">to</span>
        <input type="date" aria-label={`${humanize(def.name)} end`} value={raw.end ?? ''} onChange={set('end')} className={dateInputClass} />
      </span>
    );
  }

  if (def.kind === 'checkbox') {
    return <Switch checked={resolved.raw === true} onChange={(checked) => patch(checked)} />;
  }

  // text | number — inline input on click
  if (draft !== null) {
    const commit = () => {
      const trimmed = draft.trim();
      patch(trimmed === '' ? null : def.kind === 'number' ? Number(trimmed) : trimmed);
      setDraft(null);
    };
    return (
      <input
        autoFocus
        aria-label={humanize(def.name)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className="h-[26px] w-40 rounded-md border border-[var(--cortex-500)] px-1.5 text-[13px] text-[var(--n-900)] shadow-[0_0_0_3px_var(--cortex-100)] outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setDraft(resolved.display)}
      className="inline-flex rounded-md px-2 py-[3px] text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
    >
      {resolved.display === '' ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
    </button>
  );
}
```

- [ ] **Step 5: Write `src/detail/DetailPanel.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { readNote, saveNote, setNoteTitle } from '@/lib/ipc';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';

export function DetailPanel() {
  const detailPath = useUiStore((s) => s.detailPath);
  const closeDetail = useUiStore((s) => s.closeDetail);
  const toast = useUiStore((s) => s.toast);
  const entry = useEntry(detailPath);
  const schema = useSchema();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState<string | null>(null);
  const [savedBody, setSavedBody] = useState('');

  useEffect(() => {
    setTitle(entry?.title ?? '');
  }, [entry?.path, entry?.title]);

  useEffect(() => {
    setBody(null);
    if (!entry || !vaultPath) return;
    let cancelled = false;
    void readNote(vaultPath, entry.path).then((text) => {
      if (!cancelled) {
        setBody(text);
        setSavedBody(text);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [entry?.path, vaultPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDetail]);

  if (!detailPath || !entry) return null;

  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
  const declared = typeDef?.fields ?? [];
  const declaredNames = new Set(declared.map((f) => f.name));
  const undeclared = [...Object.keys(entry.properties), ...Object.keys(entry.relationships)].filter(
    (k) => !declaredNames.has(k) && k !== 'type' && k !== 'key',
  );
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';

  const commitTitle = async () => {
    const trimmed = title.trim();
    if (!vaultPath || trimmed === '' || trimmed === entry.title) {
      setTitle(entry.title);
      return;
    }
    await setNoteTitle(vaultPath, entry.path, trimmed);
    await rescan();
  };

  const commitBody = async () => {
    if (!vaultPath || body === null || body === savedBody) return;
    await saveNote(vaultPath, entry.path, body);
    setSavedBody(body);
    toast('Saved');
  };

  return (
    <aside
      aria-label="Detail panel"
      className="cb-panel-in fixed right-0 top-0 z-30 flex h-full w-[420px] flex-col border-l border-[var(--n-200)] bg-[var(--n-0)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--n-100)] px-4 py-3">
        <span className="inline-flex" style={{ color: typeDef?.color ?? 'var(--n-500)' }}>
          <Icon name={typeDef?.icon ?? 'file-text'} size={14} />
        </span>
        <span className="text-[12px] font-medium text-[var(--n-700)]">{entry.type ?? 'Note'}</span>
        {key !== '' && <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-500)]">{key}</span>}
        <span className="flex-1" />
        <IconButton icon="x" label="Close" size="sm" onClick={closeDetail} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3.5">
        <input
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setTitle(entry.title);
            }
          }}
          className="-ml-2 mb-3.5 w-full rounded-lg border border-transparent px-2 py-1 text-[16px] font-semibold leading-[22px] tracking-[-0.01em] text-[var(--n-900)] outline-none hover:border-[var(--n-200)] focus:border-[var(--cortex-500)] focus:shadow-[0_0_0_3px_var(--cortex-100)]"
        />
        <div className="mb-4 flex flex-col gap-[7px]">
          {declared.map((f) => (
            <div key={f.name} className="flex items-center gap-2">
              <span className="w-24 flex-none text-[12px] text-[var(--n-500)]">{humanize(f.name)}</span>
              <FieldEditor entry={entry} def={f} schema={schema} />
            </div>
          ))}
          {undeclared.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-24 flex-none text-[12px] text-[var(--n-500)]">{humanize(name)}</span>
              <span className="text-[12.5px] text-[var(--n-700)]">
                {name in entry.relationships
                  ? entry.relationships[name].join(', ')
                  : String(entry.properties[name])}
              </span>
            </div>
          ))}
        </div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">Description</div>
        <textarea
          aria-label="Description"
          placeholder="Add a description…"
          value={body ?? ''}
          disabled={body === null}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => void commitBody()}
          className="mb-4 block min-h-[96px] w-full resize-y rounded-lg border border-[var(--n-200)] px-2.5 py-2 text-[13px] leading-5 text-[var(--n-700)] outline-none focus:border-[var(--cortex-500)] focus:shadow-[0_0_0_3px_var(--cortex-100)]"
        />
      </div>
      <footer className="flex items-center gap-3 border-t border-[var(--n-100)] px-4 py-2.5 [font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
        <span>Created {entry.createdAt.slice(0, 10)}</span>
        <span>Modified {entry.modifiedAt.slice(0, 10)}</span>
      </footer>
    </aside>
  );
}
```

- [ ] **Step 6: Wire keyframes and mount the panel**

Append to the end of `src/styles/index.css`:

```css
/* Detail panel entrance (prototype cbPanelIn, DS motion) */
@keyframes cb-panel-in {
  from { opacity: 0; transform: translateX(8px); }
  to { opacity: 1; transform: none; }
}
.cb-panel-in { animation: cb-panel-in 180ms cubic-bezier(0.2, 0.6, 0.2, 1); }
```

In `src/App.tsx` (created in Task 17), add the import:

```tsx
import { DetailPanel } from '@/detail/DetailPanel';
```

and render `<DetailPanel />` once, as the last child inside the root element returned by `App` (it is `position: fixed` and guards on `detailPath`, so placement does not affect layout):

```tsx
      <DetailPanel />
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run src/detail/DetailPanel.test.tsx`
Expected: PASS (status patch, undeclared advisory row, Escape close, null render).

- [ ] **Step 8: Commit**

```
git add src/detail/FieldPopover.tsx src/detail/FieldEditor.tsx src/detail/DetailPanel.tsx src/detail/DetailPanel.test.tsx src/styles/index.css src/App.tsx
git commit -m "feat: add schema-driven detail panel with field editors"
```

---

### Task 23: QuickOpen (⌘K), CreateMenu, SettingsPage, ToastHost

**Files:**
- Create: `src/app/QuickOpen.tsx`
- Create: `src/app/CreateMenu.tsx`
- Create: `src/app/ToastHost.tsx`
- Create: `src/pages/SettingsPage.tsx`
- Modify: `src/App.tsx` (⌘K keydown effect, mount QuickOpen/ToastHost, route settings)
- Modify: `src/app/Topbar.tsx` (render CreateMenu)
- Test: `src/app/QuickOpen.test.tsx`
- Test: `src/app/CreateMenu.test.tsx`

QuickOpen mirrors the prototype search palette (`data-screen-label="Search"`); the create menu mirrors the topbar "+ New" dropdown; SettingsPage mirrors `data-screen-label="Settings"`. Status templates are the prototype's `STATUS_PRESETS` from `docs/cerebro-with-teams/cerebro-work-data.js` (ids, groups, colors, hollow flags verbatim; prototype `name` keys become `label`).

**DS prop APIs relied on:**

```ts
// feedback/Dialog.d.ts
export interface DialogAction { label: string; onClick?: () => void; disabled?: boolean }
export interface DialogProps { open: boolean; onClose?: () => void; title: string; children?: React.ReactNode; width?: number; primaryAction?: DialogAction; secondaryAction?: DialogAction; footerNote?: string; ... }
// feedback/Toast.d.ts
export interface ToastProps { tone?: "neutral" | "success" | "warn" | "danger" | "ai"; title: string; description?: string; onDismiss?: () => void; ... }
// core/Button.d.ts
export interface ButtonProps { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg"; icon?: string; onClick?: () => void; ... }
// core/Select.d.ts
export interface SelectOption { value: string; label: string }
export interface SelectProps { options: SelectOption[]; value?: string; onChange?: (e: any) => void; width?: number | string; ... }
```

- [ ] **Step 1: Write the failing tests**

`src/app/QuickOpen.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuickOpen } from '@/app/QuickOpen';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

describe('QuickOpen', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ quickOpenVisible: true });
  });

  it('ranks an exact title prefix above a mid-title match', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText('Search items, projects, and spaces…'), 'field');
    const options = screen.getAllByRole('option');
    // 'Field platform' (prefix match) must outrank 'Wire field sync banner' (substring match)
    expect(options[0].textContent).toContain('Field platform');
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it('Enter navigates to the top result and closes the palette', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(
      screen.getByPlaceholderText('Search items, projects, and spaces…'),
      'field{Enter}',
    );
    expect(useNavStore.getState().selection).toEqual({ kind: 'space', path: 'spaces/field-platform.md' });
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('picking an item opens its detail and navigates to its project', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText('Search items, projects, and spaces…'), 'wire');
    await user.click(screen.getAllByRole('option')[0]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'project', path: 'projects/onboarding.md' });
    expect(useUiStore.getState().detailPath).toBe('items/fld-2.md');
  });
});
```

`src/app/CreateMenu.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateMenu } from '@/app/CreateMenu';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

describe('CreateMenu', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  it('creates an item from the new item dialog', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/ship-the-fix.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New item' }));
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Ship the fix');
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: 'items',
      slug: 'ship-the-fix',
      frontmatter: { type: 'Work item', key: 'FLD-3', project: '[[onboarding]]' },
    });
  });

  it('disables project creation until the key prefix is 2-4 uppercase letters', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('projects/atlas.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByPlaceholderText('Project name'), 'Atlas');
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'A');
    expect(
      (screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'TL');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects',
      slug: 'atlas',
      frontmatter: { type: 'Project', key: 'ATL', space: '[[field-platform]]' },
    });
  });

  it('creates a space seeded with the selected status template', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('spaces/growth.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New space' }));
    await user.type(screen.getByPlaceholderText('Space name'), 'Growth');
    await user.selectOptions(screen.getByLabelText('Status template'), 'simple');
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    const args = createItem.mock.calls[0][0];
    expect(args.folder).toBe('spaces');
    expect(args.slug).toBe('growth');
    expect(args.frontmatter.type).toBe('Space');
    expect(args.frontmatter.statuses).toEqual([
      { id: 'todo', label: 'Todo', group: 'active', color: 'var(--n-500)', hollow: true },
      { id: 'doing', label: 'Doing', group: 'active', color: 'var(--warn-500)' },
      { id: 'done', label: 'Done', group: 'done', color: 'var(--success-500)' },
      { id: 'dropped', label: 'Dropped', group: 'closed', color: 'var(--n-400)' },
    ]);
  });
});
```

Note: the `getByLabelText('Status template')` query requires the Select to carry `aria-label="Status template"` — if the ported DS Select does not forward `aria-label` via `style`/`className` spread, wrap it in a `<label>` and query by that instead; the implementation below uses a wrapping `<label>` plus `aria-label` on a native fallback-safe wrapper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/QuickOpen.test.tsx src/app/CreateMenu.test.tsx`
Expected: FAIL — `Cannot find module '@/app/QuickOpen'` / `Cannot find module '@/app/CreateMenu'`.

- [ ] **Step 3: Write `src/app/QuickOpen.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { quickOpenScore } from '@/lib/quickOpenScore';
import { resolveTarget } from '@/engine/wikilink';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry } from '@/engine/types';

export function QuickOpen() {
  const visible = useUiStore((s) => s.quickOpenVisible);
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);
  const openDetail = useUiStore((s) => s.openDetail);
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const q = query.trim();
    if (q === '') return [];
    return entries
      .map((e) => ({
        entry: e,
        score: Math.max(
          quickOpenScore(q, e.title),
          quickOpenScore(q, typeof e.properties.key === 'string' ? e.properties.key : ''),
        ),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [entries, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [visible]);

  const close = () => setQuickOpen(false);

  const pick = (entry: Entry) => {
    close();
    if (entry.type === 'Space') {
      navigate({ kind: 'space', path: entry.path });
      return;
    }
    if (entry.type === 'Project') {
      navigate({ kind: 'project', path: entry.path });
      return;
    }
    const target = entry.relationships.project?.[0];
    const project = target ? resolveTarget(target, entries) : null;
    if (project) navigate({ kind: 'project', path: project.path });
    openDetail(entry.path);
  };

  if (!visible) return null;

  return (
    <Dialog open onClose={close} title="Quick open" width={580}>
      <Input
        autoFocus
        icon="search"
        placeholder="Search items, projects, and spaces…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          }
          if (e.key === 'Enter' && results[activeIndex]) pick(results[activeIndex].entry);
          if (e.key === 'Escape') close();
        }}
        width="100%"
      />
      <div role="listbox" aria-label="Quick open results" className="mt-1.5 max-h-[380px] overflow-y-auto">
        {results.map((r, i) => (
          <button
            key={r.entry.path}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onClick={() => pick(r.entry)}
            onMouseEnter={() => setActiveIndex(i)}
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left"
            style={{ background: i === activeIndex ? 'var(--n-50)' : 'transparent' }}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-900)]">{r.entry.title}</span>
            {typeof r.entry.properties.key === 'string' && (
              <span className="[font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
                {r.entry.properties.key}
              </span>
            )}
            <span className="flex-none [font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
              {r.entry.type ?? 'Note'}
            </span>
          </button>
        ))}
        {query.trim() === '' && (
          <div className="px-3 py-4 text-[12px] text-[var(--n-500)]">Type to search every entry in the vault.</div>
        )}
        {query.trim() !== '' && results.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-[var(--n-500)]">No matches. Try a different term.</div>
        )}
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Write `src/app/CreateMenu.tsx` — templates, menu shell, new item dialog**

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { nextItemKey } from '@/engine/itemKeys';
import { formatWikilink } from '@/engine/wikilink';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

/** Prototype STATUS_PRESETS (docs/cerebro-with-teams/cerebro-work-data.js); `name` keys become `label`. */
export const STATUS_TEMPLATES = {
  cerebro: [
    { id: 'backlog', label: 'Backlog', group: 'active', color: 'var(--n-400)', hollow: true },
    { id: 'todo', label: 'Todo', group: 'active', color: 'var(--n-500)' },
    { id: 'progress', label: 'In progress', group: 'active', color: 'var(--warn-500)' },
    { id: 'review', label: 'In review', group: 'active', color: 'var(--swatch-sky)' },
    { id: 'done', label: 'Done', group: 'done', color: 'var(--success-500)' },
    { id: 'cancelled', label: 'Cancelled', group: 'closed', color: 'var(--n-400)' },
  ],
  marketing: [
    { id: 'idea', label: 'Idea', group: 'active', color: 'var(--n-400)', hollow: true },
    { id: 'drafting', label: 'Drafting', group: 'active', color: 'var(--warn-500)' },
    { id: 'review', label: 'In review', group: 'active', color: 'var(--swatch-sky)' },
    { id: 'scheduled', label: 'Scheduled', group: 'active', color: 'var(--cortex-400)' },
    { id: 'live', label: 'Live', group: 'done', color: 'var(--success-500)' },
    { id: 'killed', label: 'Killed', group: 'closed', color: 'var(--n-400)' },
  ],
  simple: [
    { id: 'todo', label: 'Todo', group: 'active', color: 'var(--n-500)', hollow: true },
    { id: 'doing', label: 'Doing', group: 'active', color: 'var(--warn-500)' },
    { id: 'done', label: 'Done', group: 'done', color: 'var(--success-500)' },
    { id: 'dropped', label: 'Dropped', group: 'closed', color: 'var(--n-400)' },
  ],
};

/** The 8 DS user-assignable swatches (tokens/colors.css). */
export const USER_SWATCHES = [
  'var(--swatch-amber)',
  'var(--swatch-blue)',
  'var(--swatch-teal)',
  'var(--swatch-green)',
  'var(--swatch-violet)',
  'var(--swatch-magenta)',
  'var(--swatch-vermilion)',
  'var(--swatch-sky)',
];

type CreateDialog = 'item' | 'project' | 'space' | null;

function MenuEntry({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[7px] px-2 py-[7px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
    >
      <Icon name={icon} size={14} color="var(--n-500)" />
      {label}
    </button>
  );
}

export function CreateMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<CreateDialog>(null);
  const openDialog = (d: CreateDialog) => {
    setMenuOpen(false);
    setDialog(d);
  };

  return (
    <div className="relative">
      <Button variant="primary" size="sm" icon="plus" onClick={() => setMenuOpen((v) => !v)}>
        New
      </Button>
      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-transparent"
          />
          <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-md)]">
            <MenuEntry label="New item" icon="circle-check" onClick={() => openDialog('item')} />
            <MenuEntry label="New project" icon="folder" onClick={() => openDialog('project')} />
            <MenuEntry label="New space" icon="box" onClick={() => openDialog('space')} />
          </div>
        </>
      )}
      {dialog === 'item' && <NewItemDialog onClose={() => setDialog(null)} />}
      {dialog === 'project' && <NewProjectDialog onClose={() => setDialog(null)} />}
      {dialog === 'space' && <NewSpaceDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function NewItemDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((s) => s.entries);
  const createItem = useVaultStore((s) => s.createItem);
  const openDetail = useUiStore((s) => s.openDetail);
  const projects = entries.filter((e) => e.type === 'Project');
  const [title, setTitle] = useState('');
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '');

  const create = async () => {
    const trimmed = title.trim();
    const project = entries.find((e) => e.path === projectPath);
    if (trimmed === '' || !project) return;
    const prefix = typeof project.properties.key === 'string' ? project.properties.key : 'WRK';
    const path = await createItem({
      folder: 'items',
      slug: slugify(trimmed),
      frontmatter: {
        type: 'Work item',
        key: nextItemKey(prefix, entries),
        project: formatWikilink(pathStem(project.path)),
      },
    });
    onClose();
    openDetail(path);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New item"
      primaryAction={{
        label: 'Create item',
        onClick: () => void create(),
        disabled: title.trim() === '' || projectPath === '',
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Title
          <Input autoFocus placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} width="100%" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Project
          <Select
            options={projects.map((p) => ({ value: p.path, label: p.title }))}
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            width="100%"
          />
        </label>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 5: Append project and space dialogs to `src/app/CreateMenu.tsx`**

```tsx
function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((s) => s.entries);
  const createItem = useVaultStore((s) => s.createItem);
  const navigate = useNavStore((s) => s.navigate);
  const spaces = entries.filter((e) => e.type === 'Space');
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [spacePath, setSpacePath] = useState(spaces[0]?.path ?? '');
  const prefixValid = /^[A-Z]{2,4}$/.test(prefix);

  const create = async () => {
    if (name.trim() === '' || !prefixValid || spacePath === '') return;
    const path = await createItem({
      folder: 'projects',
      slug: slugify(name.trim()),
      frontmatter: { type: 'Project', key: prefix, space: formatWikilink(pathStem(spacePath)) },
    });
    onClose();
    navigate({ kind: 'project', path });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New project"
      primaryAction={{
        label: 'Create project',
        onClick: () => void create(),
        disabled: name.trim() === '' || !prefixValid || spacePath === '',
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Name
          <Input autoFocus placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} width="100%" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Key prefix
          <Input
            placeholder="e.g. FLD"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().slice(0, 4))}
            width={120}
          />
          {prefix !== '' && !prefixValid && (
            <span className="text-[11px] text-[var(--danger-500)]">Use 2-4 uppercase letters, e.g. FLD</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Space
          <Select
            options={spaces.map((s) => ({ value: s.path, label: s.title }))}
            value={spacePath}
            onChange={(e) => setSpacePath(e.target.value)}
            width="100%"
          />
        </label>
      </div>
    </Dialog>
  );
}

function NewSpaceDialog({ onClose }: { onClose: () => void }) {
  const createItem = useVaultStore((s) => s.createItem);
  const navigate = useNavStore((s) => s.navigate);
  const [name, setName] = useState('');
  const [swatch, setSwatch] = useState(USER_SWATCHES[0]);
  const [template, setTemplate] = useState<keyof typeof STATUS_TEMPLATES>('cerebro');

  const create = async () => {
    if (name.trim() === '') return;
    const path = await createItem({
      folder: 'spaces',
      slug: slugify(name.trim()),
      frontmatter: {
        type: 'Space',
        color: swatch,
        statuses: STATUS_TEMPLATES[template].map((s) => ({ ...s })),
      },
    });
    onClose();
    navigate({ kind: 'space', path });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New space"
      primaryAction={{ label: 'Create space', onClick: () => void create(), disabled: name.trim() === '' }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Name
          <Input autoFocus placeholder="Space name" value={name} onChange={(e) => setName(e.target.value)} width="100%" />
        </label>
        <div className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Color
          <div className="flex items-center gap-2">
            {USER_SWATCHES.map((s) => {
              const swatchName = s.replace('var(--swatch-', '').replace(')', '');
              return (
                <button
                  key={s}
                  type="button"
                  aria-label={`Color ${swatchName}`}
                  aria-pressed={s === swatch}
                  onClick={() => setSwatch(s)}
                  className="h-6 w-6 rounded-md"
                  style={{
                    background: s,
                    boxShadow: s === swatch ? `0 0 0 2px var(--n-0), 0 0 0 4px ${s}` : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>
        <label aria-label="Status template" className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Status template
          <Select
            options={[
              { value: 'cerebro', label: 'Cerebro flow' },
              { value: 'marketing', label: 'Marketing' },
              { value: 'simple', label: 'Simple' },
            ]}
            value={template}
            onChange={(e) => setTemplate(e.target.value as keyof typeof STATUS_TEMPLATES)}
            width="100%"
          />
        </label>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 6: Write `src/app/ToastHost.tsx` and `src/pages/SettingsPage.tsx`**

`src/app/ToastHost.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { Toast } from '@/components/ui/Toast';
import { useUiStore } from '@/stores/uiStore';

const AUTO_DISMISS_MS = 3000;

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    for (const t of toasts) {
      if (!timers.current.has(t.id)) {
        timers.current.set(
          t.id,
          setTimeout(() => {
            timers.current.delete(t.id);
            dismissToast(t.id);
          }, AUTO_DISMISS_MS),
        );
      }
    }
  }, [toasts, dismissToast]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[80] flex w-[360px] -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} title={t.message} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}
```

`src/pages/SettingsPage.tsx`:

```tsx
import { Button } from '@/components/ui/Button';
import { pickVault } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

const APP_VERSION = '0.1.0';

export function SettingsPage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);

  const changeVault = async () => {
    const picked = await pickVault();
    if (picked) await openVault(picked);
  };

  return (
    <div className="mx-auto w-full max-w-[640px] px-8 py-8">
      <h1 className="mb-6 text-[18px] font-semibold tracking-[-0.01em] text-[var(--n-900)]">Settings</h1>
      <section className="mb-6 rounded-[14px] border border-[var(--n-200)] p-5">
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">Vault</h2>
        <p className="mb-3 text-[12.5px] text-[var(--n-500)]">
          Cerebro reads and writes plain markdown files in this folder.
        </p>
        <div className="mb-4 rounded-lg border border-[var(--n-200)] bg-[var(--n-25)] px-3 py-2 [font-family:var(--font-mono)] text-[12px] text-[var(--n-700)]">
          {vaultPath ?? 'No vault open'}
        </div>
        <Button variant="secondary" size="sm" icon="folder-open" onClick={() => void changeVault()}>
          Change vault…
        </Button>
      </section>
      <section className="rounded-[14px] border border-[var(--n-200)] p-5">
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">About</h2>
        <p className="text-[12.5px] text-[var(--n-500)]">
          Cerebro <span className="[font-family:var(--font-mono)]">{APP_VERSION}</span>
        </p>
      </section>
    </div>
  );
}
```

- [ ] **Step 7: Wire into App and Topbar**

In `src/App.tsx` (from Task 17), add imports:

```tsx
import { useEffect } from 'react';
import { QuickOpen } from '@/app/QuickOpen';
import { ToastHost } from '@/app/ToastHost';
import { SettingsPage } from '@/pages/SettingsPage';
import { useUiStore } from '@/stores/uiStore';
```

Add this effect at the top of the `App` component body:

```tsx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUiStore.getState().setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
```

Render `<QuickOpen />` and `<ToastHost />` once, as the last children of the root element returned by `App` (next to `<DetailPanel />` from Task 22). In the canvas selection switch, route `selection.kind === 'settings'` to `<SettingsPage />` (replace Task 17's placeholder if one exists).

In `src/app/Topbar.tsx` (from Task 17), add:

```tsx
import { CreateMenu } from '@/app/CreateMenu';
```

and render `<CreateMenu />` in the topbar's right-hand cluster (immediately right of the centered quick-open input, before the avatar placeholder), replacing any "+ New" placeholder button Task 17 left there.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run src/app/QuickOpen.test.tsx src/app/CreateMenu.test.tsx`
Expected: PASS (prefix ranking, Enter navigation, item detail open, item/project/space creation, prefix validation).

- [ ] **Step 9: Verify the chrome in the browser**

Run: `pnpm dev`
Expected: ⌘K opens the quick-open dialog and typing filters entries; "+ New" opens the menu and each dialog creates a note in the mock FS; Settings shows the vault path in mono with a working "Change vault…" button; board drags and detail saves now show bottom-center toasts that dismiss after 3 seconds.

- [ ] **Step 10: Commit**

```
git add src/app/QuickOpen.tsx src/app/QuickOpen.test.tsx src/app/CreateMenu.tsx src/app/CreateMenu.test.tsx src/app/ToastHost.tsx src/pages/SettingsPage.tsx src/App.tsx src/app/Topbar.tsx
git commit -m "feat: add quick open, create menu, settings page, and toasts"
```


### Task 24: Playwright smoke test (browser mode, mock IPC)

End-to-end proof for M1: boot the app in the browser against the mock IPC demo vault, browse space → project, see the grouped list, switch to board, drag a card between columns and verify the frontmatter write landed in the mock filesystem, rename an item title from the detail panel and verify the H1 write, and find an item by key through quick open (⌘K). One config, one spec file, one test.

**Depends on:** Tasks 10 (mock IPC exposes `window.__cerebroMockFs`), 17–23 (shell, sidebar, views, board, detail panel, quick open all exist).

**Contract with Task 10 (restated so this task is self-contained):** `mockIpc.ts` exposes `window.__cerebroMockFs: Map<string, string>` where keys are **vault-relative paths** matching `Entry.path` (e.g. `items/fld-7.md`) and values are the **full file text** (frontmatter + body). All mock writes (`updateFrontmatter`, `setNoteTitle`, `saveNote`, `createNote`) mutate this Map. If Task 10 keyed the Map differently, fix Task 10's Map keys to be vault-relative — this spec depends on it.

**Contract with Task 17:** the first-launch chooser button label is exactly `Open demo vault` (sentence case, per DS). The spec targets it by accessible role + name.

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/smoke.spec.ts`
- Modify: `vite.config.ts` (exclude `e2e/**` from Vitest)
- Modify: `package.json` (add `@playwright/test` devDependency if Task 1 did not, add `e2e` script)
- Modify: `src/app/Sidebar.tsx`, `src/views/ViewToolbar.tsx`, `src/components/ui/SegmentedControl.tsx`, `src/views/ListView.tsx`, `src/views/BoardView.tsx`, `src/detail/DetailPanel.tsx`, `src/app/QuickOpen.tsx` (data-testid attributes only)
- Test: `e2e/smoke.spec.ts` (this task's test *is* the deliverable)

- [ ] **Step 1: Install Playwright and the chromium binary**

  ```bash
  pnpm add -D @playwright/test@^1.54
  pnpm exec playwright install chromium
  ```

  (If `@playwright/test` is already in `package.json` from Task 1, the first command is a no-op version bump check — keep `^1.54`.)

- [ ] **Step 2: Write `playwright.config.ts`**

  Full file contents:

  ```ts
  import { defineConfig } from '@playwright/test';

  const baseURL = process.env.BASE_URL ?? 'http://localhost:5173';

  export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    use: {
      baseURL,
      headless: true,
    },
    webServer: {
      command: 'pnpm dev',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  });
  ```

  `pnpm dev` is plain Vite (browser mode → `ipc.ts` falls back to `mockIpc.ts`), default port 5173.

- [ ] **Step 3: Exclude `e2e/**` from Vitest**

  Vitest's default include pattern (`**/*.{test,spec}.*`) would try to execute `e2e/smoke.spec.ts` and crash on `@playwright/test`. In `vite.config.ts`, inside the existing `test` block from Task 1, add an `exclude`:

  ```ts
  import { configDefaults } from 'vitest/config';
  ```

  ```ts
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      exclude: [...configDefaults.exclude, 'e2e/**'],
    },
  ```

  Only the `exclude` line and the `configDefaults` import are new — keep whatever other `test` options Task 1 configured. Verify with:

  ```bash
  pnpm vitest run --reporter=basic 2>&1 | grep -c "e2e/"
  ```

  Expected: `0` (no e2e files collected).

- [ ] **Step 4: Write the failing smoke spec — part 1 (boot, sidebar, list, board)**

  Create `e2e/smoke.spec.ts` with exactly this content (the file is completed in Step 5):

  ```ts
  import { test, expect, type Page } from '@playwright/test';

  declare global {
    interface Window {
      __cerebroMockFs: Map<string, string>;
    }
  }

  /** Read a file's full text (frontmatter + body) from the mock filesystem. */
  async function readMockFile(page: Page, path: string): Promise<string> {
    const text = await page.evaluate((p) => window.__cerebroMockFs.get(p), path);
    if (text === undefined) throw new Error(`mock fs has no file at ${path}`);
    return text;
  }

  test('smoke: boot demo vault, list, board drag writes disk, rename, quick open', async ({ page }) => {
    // -- Boot -----------------------------------------------------------
    await page.goto('/');

    // With no persisted vault the first-launch chooser renders "Open demo
    // vault"; if the mock IPC restored a last vault it boots straight to the
    // shell. Handle both.
    const demoButton = page.getByRole('button', { name: 'Open demo vault' });
    const sidebarSpaces = page.getByTestId('sidebar-space');
    await expect(demoButton.or(sidebarSpaces.first())).toBeVisible({ timeout: 10_000 });
    if (await demoButton.isVisible()) {
      await demoButton.click();
    }

    // -- Sidebar lists at least one space --------------------------------
    await expect(sidebarSpaces.first()).toBeVisible({ timeout: 10_000 });
    expect(await sidebarSpaces.count()).toBeGreaterThanOrEqual(1);

    // -- Expand the first space, open its first project -------------------
    await sidebarSpaces.first().click();
    const sidebarProjects = page.getByTestId('sidebar-project');
    await expect(sidebarProjects.first()).toBeVisible();
    await sidebarProjects.first().click();

    // -- List view: grouped section headers visible ----------------------
    const groupHeaders = page.getByTestId('list-group-header');
    await expect(groupHeaders.first()).toBeVisible();
    expect(await groupHeaders.count()).toBeGreaterThanOrEqual(1);

    // -- Switch to board via the toolbar ---------------------------------
    await page.getByTestId('view-switch-board').click();
    const columns = page.getByTestId('board-column');
    await expect(columns.first()).toBeVisible();
    expect(await columns.count()).toBeGreaterThanOrEqual(2);
  });
  ```

- [ ] **Step 5: Write the failing smoke spec — part 2 (drag, mock FS assert, rename, quick open)**

  In `e2e/smoke.spec.ts`, replace the final two lines of the file —

  ```ts
    expect(await columns.count()).toBeGreaterThanOrEqual(2);
  });
  ```

  — with:

  ```ts
    expect(await columns.count()).toBeGreaterThanOrEqual(2);

    // -- Pick a source card and a different target column ----------------
    const sourceColumn = columns.filter({ has: page.getByTestId('board-card') }).first();
    const sourceKey = await sourceColumn.getAttribute('data-group-key');
    const card = sourceColumn.getByTestId('board-card').first();
    const cardPath = await card.getAttribute('data-path');
    const itemKey = (await card.getByTestId('card-key').innerText()).trim();
    const targetColumn = page
      .locator(`[data-testid="board-column"]:not([data-group-key="${sourceKey}"])`)
      .first();
    const targetKey = await targetColumn.getAttribute('data-group-key');
    if (!cardPath || !sourceKey || !targetKey) {
      throw new Error('board columns/cards are missing data attributes');
    }
    expect(targetKey).not.toBe(sourceKey);
    expect(itemKey.length).toBeGreaterThan(0);

    // -- Drag the card into the target column ----------------------------
    // PRIMARY APPROACH: raw pointer steps. dnd-kit's PointerSensor listens to
    // pointerdown/pointermove/pointerup. page.dragAndDrop() / locator.dragTo()
    // synthesize HTML5 drag events (dragstart/drop), which dnd-kit ignores —
    // they are NOT a working fallback for this board. If this sequence flakes
    // in CI, the fallback is tuning, not a different API: raise `steps`, add
    // `await page.waitForTimeout(100)` before mouse.up(), and drop onto the
    // target column's first card instead of the column body.
    const cardBox = await card.boundingBox();
    const targetBox = await targetColumn.boundingBox();
    if (!cardBox || !targetBox) throw new Error('missing drag geometry');
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    // Small first move clears dnd-kit's activation distance constraint.
    await page.mouse.move(
      cardBox.x + cardBox.width / 2 + 12,
      cardBox.y + cardBox.height / 2 + 12,
      { steps: 4 },
    );
    await page.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + Math.min(targetBox.height - 8, 160),
      { steps: 16 },
    );
    await page.mouse.up();

    // -- Card renders in the target column -------------------------------
    const movedCard = targetColumn.locator(
      `[data-testid="board-card"][data-path="${cardPath}"]`,
    );
    await expect(movedCard).toBeVisible();

    // -- The mock filesystem was written (disk-first write) --------------
    await expect
      .poll(() => readMockFile(page, cardPath), { timeout: 5_000 })
      .toMatch(new RegExp(`status:\\s*['"]?${targetKey}['"]?`));

    // -- Detail panel: rename the title ----------------------------------
    await movedCard.click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    const titleInput = page.getByTestId('detail-title');
    await expect(titleInput).toBeVisible();
    await titleInput.fill('Renamed by smoke');
    await titleInput.press('Enter'); // commits the rename (Task 22 wiring)
    await expect
      .poll(() => readMockFile(page, cardPath), { timeout: 5_000 })
      .toContain('# Renamed by smoke');
    await page.keyboard.press('Escape'); // close the detail panel

    // -- Quick open finds the item by key --------------------------------
    await page.keyboard.press('ControlOrMeta+k');
    const quickOpenInput = page.getByTestId('quick-open-input');
    await expect(quickOpenInput).toBeVisible();
    await quickOpenInput.fill(itemKey);
    const results = page.getByTestId('quick-open-result');
    await expect(results.first()).toBeVisible();
    await expect(results.filter({ hasText: itemKey }).first()).toBeVisible();
  });
  ```

- [ ] **Step 6: Run the spec to verify it fails**

  Run: `pnpm exec playwright test`

  Expected: FAIL. The web server boots and the page loads, but the test times out on `getByTestId('sidebar-space')` (`TimeoutError: locator.toBeVisible`), because none of the `data-testid` attributes exist yet. (If it instead fails on the `Open demo vault` / sidebar race locator, Task 17's chooser button label differs — fix that label to exactly `Open demo vault` as part of Step 7.)

- [ ] **Step 7: Add data-testid attributes — sidebar and toolbar**

  Every testid the spec relies on, and where it lives:

  | data-testid | File | Element |
  |---|---|---|
  | `sidebar-space` | `src/app/Sidebar.tsx` | clickable space row in the spaces tree (one per space) |
  | `sidebar-project` | `src/app/Sidebar.tsx` | clickable project row under an expanded space |
  | `view-switch-list` / `view-switch-board` | `src/views/ViewToolbar.tsx` (+ `SegmentedControl.tsx`) | the two view-switcher segments |
  | `list-group-header` | `src/views/ListView.tsx` | 36px group section header (one per group) |
  | `board-column` | `src/views/BoardView.tsx` | column root, plus `data-group-key={group.key}` |
  | `board-card` | `src/views/BoardView.tsx` | draggable card root, plus `data-path={entry.path}` |
  | `card-key` | `src/views/BoardView.tsx` | the mono item-key element inside the card |
  | `detail-panel` | `src/detail/DetailPanel.tsx` | the 420px `<aside>` root |
  | `detail-title` | `src/detail/DetailPanel.tsx` | the inline title rename input |
  | `quick-open-input` | `src/app/QuickOpen.tsx` | the palette's text input |
  | `quick-open-result` | `src/app/QuickOpen.tsx` | each result row (one per match) |

  Rule for every edit in Steps 7–8: add **only** the shown `data-testid` / `data-*` attributes to the *existing* element — the outermost DOM element the user actually clicks (not a wrapper) — keeping every other prop exactly as Tasks 18–23 wrote them. The fragments below show attribute placement; surrounding props in your file may differ and stay untouched.

  **`src/app/Sidebar.tsx`** — the space row button (the element whose `onClick` expands/collapses the space) and the project row button (the element whose `onClick` calls `navigate({ kind: 'project', path: project.path })`):

  ```tsx
  {/* space row — add data-testid only */}
  <button
    data-testid="sidebar-space"
    onClick={() => toggleSpace(space.path)}
    /* ...existing props/classes unchanged... */
  >
  ```

  ```tsx
  {/* project row — add data-testid only */}
  <button
    data-testid="sidebar-project"
    onClick={() => navigate({ kind: 'project', path: project.path })}
    /* ...existing props/classes unchanged... */
  >
  ```

  **`src/components/ui/SegmentedControl.tsx`** — the DS primitive renders segments from an options array, so it needs a per-option testid pass-through. Add an optional `testId` to the option type and spread it onto each segment button:

  ```tsx
  export interface SegmentedControlOption {
    value: string;
    label: string;
    testId?: string;   // NEW — forwarded as data-testid on the segment button
  }
  ```

  ```tsx
  {/* inside the options map — add data-testid only */}
  <button
    key={opt.value}
    data-testid={opt.testId}
    /* ...existing props (aria-pressed, onClick, classes) unchanged... */
  >
  ```

  **`src/views/ViewToolbar.tsx`** — pass the testids where the view switcher's options are declared:

  ```tsx
  <SegmentedControl
    value={presentation.type}
    onChange={/* existing handler unchanged */}
    options={[
      { value: 'list', label: 'List', testId: 'view-switch-list' },
      { value: 'board', label: 'Board', testId: 'view-switch-board' },
    ]}
  />
  ```

  (If Task 19 declared the options inline already, only the two `testId` keys are new.)

  Also verify Task 17's first-launch chooser button reads exactly `Open demo vault`:

  ```tsx
  <Button onClick={openDemoVault}>Open demo vault</Button>
  ```

  If the label differs (e.g. title case), change it to the sentence-case text above.

- [ ] **Step 8: Add data-testid attributes — list, board, detail, quick open**

  **`src/views/ListView.tsx`** — the group section header element (the 36px header rendered once per `Group`):

  ```tsx
  {/* group header — add data-testid only */}
  <div
    data-testid="list-group-header"
    /* ...existing props/classes unchanged... */
  >
  ```

  **`src/views/BoardView.tsx`** — three edits. Column root (rendered once per `Group`, the element containing the column header and card stack):

  ```tsx
  {/* column root — add data-testid and data-group-key only */}
  <div
    data-testid="board-column"
    data-group-key={group.key}
    /* ...existing props/classes unchanged... */
  >
  ```

  Card root — the element that carries dnd-kit's `useDraggable` ref and listeners (attributes must be on that same element so `boundingBox()` matches what the sensor sees):

  ```tsx
  {/* draggable card root — add data-testid and data-path only */}
  <div
    ref={setNodeRef}
    data-testid="board-card"
    data-path={entry.path}
    {...listeners}
    {...attributes}
    /* ...existing props/classes unchanged... */
  >
  ```

  Item key inside the card (the mono `key` text, e.g. `FLD-3`):

  ```tsx
  <span data-testid="card-key" /* ...existing mono classes unchanged... */>
    {/* existing key display expression unchanged */}
  </span>
  ```

  **`src/detail/DetailPanel.tsx`** — the panel root and the title rename input:

  ```tsx
  {/* panel root — add data-testid only */}
  <aside
    data-testid="detail-panel"
    /* ...existing props/classes unchanged... */
  >
  ```

  ```tsx
  {/* title input — add data-testid only; Enter must commit via setNoteTitle */}
  <input
    data-testid="detail-title"
    /* ...existing value/onChange/onKeyDown props unchanged... */
  />
  ```

  **`src/app/QuickOpen.tsx`** — the palette input and each result row:

  ```tsx
  {/* palette input — add data-testid only */}
  <input
    data-testid="quick-open-input"
    /* ...existing props unchanged... */
  />
  ```

  ```tsx
  {/* each result row — add data-testid only */}
  <button
    data-testid="quick-open-result"
    /* ...existing props unchanged... */
  >
  ```

  Note: the quick-open result rows must render the item's key text (they do per Task 23 — quick open matches titles + keys); the spec's `hasText: itemKey` filter depends on it.

- [ ] **Step 9: Run the spec to verify it passes**

  Run: `pnpm exec playwright test`

  Expected: PASS — `1 passed`. Also re-run the unit suite to confirm the testid edits and the Vitest exclude broke nothing:

  Run: `pnpm vitest run`

  Expected: PASS (all suites green, no `e2e/` files collected).

- [ ] **Step 10: Add the `e2e` script to package.json**

  In `package.json` `"scripts"`, add:

  ```json
  "e2e": "playwright test"
  ```

  Verify: `pnpm e2e`

  Expected: PASS — `1 passed` (reuses the already-running dev server if present).

- [ ] **Step 11: Commit**

  ```bash
  git add playwright.config.ts e2e/smoke.spec.ts vite.config.ts package.json pnpm-lock.yaml src/app/Sidebar.tsx src/app/QuickOpen.tsx src/components/ui/SegmentedControl.tsx src/views/ViewToolbar.tsx src/views/ListView.tsx src/views/BoardView.tsx src/detail/DetailPanel.tsx
  git commit -m "test: add Playwright smoke covering boot, board drag, rename, and quick open"
  ```
