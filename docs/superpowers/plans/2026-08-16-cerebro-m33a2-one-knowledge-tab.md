# M33a.2 — One Knowledge tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the Status hub into the Knowledge page as additional nav tabs, so
what the base holds, what it knows about itself, and what its agents have done
are one destination instead of two.

**Architecture:** Status's five section components (`src/status/*`) are kept
whole and re-mounted as Knowledge nav tabs. `EpistemicStatusPage`'s
scroll-column-plus-scroll-spy shell is deleted; each section renders alone
under its own tab. `Selection.status` is retired and its two payload fields
(`section`, `run`) move into `KnowledgeNav`. The rail goes 10 → 9.

**Tech Stack:** React 19, Zustand (`navStore`), TypeScript, Playwright, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-cerebro-m33a-knowledge-threads-design.md` (D2, D5, D9)

**A note on step granularity.** This is a refactor across ~15 files, not a
greenfield feature. Steps give exact paths, exact type definitions, exact test
names, and the design contract — but component bodies are moved, not rewritten,
so they are described by their move rather than reproduced. Where a step
defines a *contract* (a type, a nav table, a test), the full code is given.

---

## The design

**Nav rows, in order.** Two groups in `KnowledgeNav`:

*What the base holds*
| Row | Tab | Content |
| --- | --- | --- |
| Threads | `entity`-list landing | a.3 makes this the default; a.2 leaves the current default alone |
| All concepts | `all` | unchanged |
| Needs review | `review` | unchanged — unverified/stale/deprecated **concepts** |
| Update log | `log` | unchanged |
| Folders | `section` | renamed from "Sections" in a.3, NOT here |
| About | `entity` | renamed to "Threads" in a.3, NOT here |

*What the base knows about itself* (new)
| Row | Tab | Component moved from |
| --- | --- | --- |
| What changed | `changed` | `EpistemicStatusPage`'s `Changes` + lanes |
| What's contested | `contested` | the contradiction/blindness/staleness/debt sections |
| Waiting on you | `waiting` | `src/status/NeedsYouSection.tsx` |
| Background | `background` | `src/status/SystemSection.tsx` |
| Agent work | `runs` | `src/status/FleetSection.tsx` |
| Deferral gates | `gates` | `Gates` + `R7Scope`, collapsed per D5 |

**The rename that avoids a collision.** Status's "Needs review" section becomes
**"Waiting on you"**. Knowledge's existing "Needs review" row keeps its name.
They are unrelated queues — concepts a human has not verified, versus proposals
awaiting approve/reject — and several e2e locators filter on the literal string
`'Needs review'`.

**What is deliberately NOT in this task:** reordering to put Threads first,
renaming Sections/About, weight-sorting, the `+ Create page` affordance,
label casing. All of that is a.3. This task moves surfaces; a.3 re-ranks them.

---

## File structure

| File | Change |
| --- | --- |
| `src/engine/types.ts` | `KnowledgeNav` gains six arms; `Selection.status` and `StatusSection` deleted |
| `src/knowledge/KnowledgeNav.tsx` | second nav group |
| `src/pages/KnowledgePage.tsx` | routes the six new tabs; they bypass the 3-column layout like `log` already does |
| `src/knowledge/BaseItself.tsx` | **Create** — one component per new tab, composing the moved `src/status/*` sections |
| `src/pages/EpistemicStatusPage.tsx` | **Delete** — its `Section`/`Lane`/`Changes`/`Gates`/`R7Scope` helpers move to `BaseItself.tsx` |
| `src/status/StatusNav.tsx` | **Delete** — the Knowledge sidebar is the nav now |
| `src/status/{NeedsYouSection,SystemSection,FleetSection,RunDetailPanel}.tsx` | keep; only their `selection` reads change |
| `src/app/Rail.tsx` | Status button removed |
| `src/app/Sidebar.tsx` | `'status'` leaves `SIDEBARLESS` |
| `src/App.tsx` | `case 'status'` removed from `CanvasOutlet` |
| `src/agent/RunList.tsx` | deep-link target changes |
| `e2e/boot.ts` | `openStatusSection` becomes `openKnowledgeTab` |

---

## Task 1: The type change

**Files:**
- Modify: `src/engine/types.ts:159-164` (`KnowledgeNav`), `:182` (`StatusSection`), `:229` (`Selection.status`)
- Test: `src/app/Rail.test.tsx`

- [ ] **Step 1: Change the types**

Replace `KnowledgeNav` with:

```ts
/**
 * Where you are inside the Knowledge tab.
 *
 * M33a.2 folded the Status hub in here. The first five arms are what the base
 * HOLDS; the last six are what it knows about ITSELF and what its agents have
 * done. One destination, because they were always one subject — a bundle that
 * cannot say what it is unsure of is not a knowledge base, it is a folder.
 */
export type KnowledgeNav =
  | { tab: 'all' }
  | { tab: 'review' }
  | { tab: 'log' }
  | { tab: 'section'; folder: string }
  | { tab: 'entity'; key: string }
  | { tab: 'changed' }
  | { tab: 'contested' }
  | { tab: 'waiting' }
  | { tab: 'background' }
  // `run` deep-links one run open, the way `entity` deep-links one subject.
  | { tab: 'runs'; run?: string }
  | { tab: 'gates' };
```

Delete `StatusSection` entirely, and delete the `| { kind: 'status'; ... }` arm
from `Selection`. Delete any comment on `Selection` that explains why Status is
its own destination — the change falsifies it, and this repo does not keep
comments a change has made untrue.

- [ ] **Step 2: Let the compiler find the blast radius**

```sh
pnpm typecheck
```

Expected: FAIL, with errors in `src/App.tsx`, `src/app/Rail.tsx`,
`src/status/StatusNav.tsx`, `src/status/FleetSection.tsx`,
`src/status/RunDetailPanel.tsx`, `src/pages/EpistemicStatusPage.tsx`,
`src/agent/RunList.tsx`. **Write that list down** — it is the work of Tasks 2-4.

Do not fix them yet. Do not commit yet.

---

## Task 2: Move the surfaces

**Files:**
- Create: `src/knowledge/BaseItself.tsx`
- Delete: `src/pages/EpistemicStatusPage.tsx`, `src/status/StatusNav.tsx`
- Modify: `src/pages/KnowledgePage.tsx`, `src/status/FleetSection.tsx`, `src/status/RunDetailPanel.tsx`

- [ ] **Step 1: Create `src/knowledge/BaseItself.tsx`**

Move these out of `EpistemicStatusPage.tsx` verbatim: the `Section` wrapper
(which sets `data-section`), `Lane`, `Changes`, `Gates`, `R7Scope`, and the
feed-loading hooks each uses. **Keep `data-section` on every section root** —
30 e2e assertions address sections by that attribute and they must keep
working; only the way you *reach* a section changes.

Export one component per new tab:

```tsx
export function WhatChanged({ vaultPath }: { vaultPath: string })
export function WhatsContested({ vaultPath }: { vaultPath: string })
export function WaitingOnYou({ vaultPath }: { vaultPath: string })
export function Background({ vaultPath }: { vaultPath: string })
export function AgentWork()
export function DeferralGates({ vaultPath }: { vaultPath: string })
```

`WhatChanged` renders the `changed` section plus the attention lanes.
`WhatsContested` renders the `contradiction`, `blindness`, `staleness` and
`epistemic_debt` sections. `WaitingOnYou` wraps `NeedsYouSection`, `Background`
wraps `SystemSection`, `AgentWork` wraps `FleetSection` (no vault — the fleet
spans vaults). `DeferralGates` wraps `Gates` + `R7Scope`.

Give the module a doc comment saying where it came from and why the scroll
column died: five sections in one column was 5,799px in an 844px viewport, and
`Deferral gates` alone was 3,225px of "Never evaluated here."

- [ ] **Step 2: Delete `StatusNav.tsx` and the scroll-spy**

`useScrollToSection`, `useVisibleSection` and the `data-target` attribute all go.
The Knowledge sidebar is the nav now, and a tab renders one section, so there
is nothing to scroll-spy. `data-target` is read only by
`e2e/status.spec.ts:286,288` — that test is updated in Task 5.

- [ ] **Step 3: Route the tabs in `KnowledgePage.tsx`**

The `log` tab already short-circuits before the 3-column layout
(`KnowledgePage.tsx:278-284`). Follow that exact pattern: the six new tabs
render their `BaseItself` component alone, under the same page heading
treatment, and never reach the concept-list layout.

- [ ] **Step 4: Fix the two `selection` reads**

`FleetSection.tsx:78` currently reads
`selection.kind === 'status' ? selection.run : undefined`. It becomes
`selection.kind === 'knowledge' && selection.nav?.tab === 'runs' ? selection.nav.run : undefined`.

`RunDetailPanel.tsx:175` navigates to `{ kind: 'status', section: 'needs-review' }`.
It becomes `{ kind: 'knowledge', nav: { tab: 'waiting' } }`.

- [ ] **Step 5: Typecheck**

```sh
pnpm typecheck
```

Expected: only `App.tsx`, `Rail.tsx` and `RunList.tsx` still failing — Task 3.

---

## Task 3: Retire the rail button

**Files:** `src/app/Rail.tsx`, `src/app/Sidebar.tsx`, `src/App.tsx`, `src/agent/RunList.tsx`, `src/app/Rail.test.tsx`, `src/agent/RunList.test.tsx`

- [ ] **Step 1: Update the rail test FIRST**

`src/app/Rail.test.tsx:51-74` asserts the exact ordered list. Change it to nine
and add the rule the merge encodes, mirroring the two `not.toContain` lines the
*previous* merge left as a template:

```ts
expect(labels).toEqual([
  'Home', 'Inbox', 'Docs', 'Workspace', 'Knowledge', 'History',
  'Assistant', 'Library', 'Settings',
]);
// M33a.2 folded the Status hub into Knowledge. These were rail destinations
// once; each merge that removes one leaves its name here, because the failure
// mode is a button silently coming back.
expect(labels).not.toContain('Status');
expect(labels).not.toContain('Needs review');
expect(labels).not.toContain('Background');
```

Also update the test's name — it says "ten destinations" and there are nine.

```sh
pnpm test:run src/app/Rail.test.tsx
```
Expected: FAIL (Status is still rendered).

- [ ] **Step 2: Remove the button**

Delete the Status `RailButton` (`Rail.tsx:138`) and the `statusActive` read
(`:103`). Delete `'status'` from `SIDEBARLESS` in `Sidebar.tsx:70-78`. Delete
`case 'status'` from `CanvasOutlet` (`App.tsx:124-125`).

**Check the comments.** `Rail.tsx:100-102` explains why Status is deliberately
not badged, and `Sidebar.tsx:67-69` explains why it is sidebarless. Both are
falsified by this change — delete them. If the no-badge reasoning is still worth
keeping, it belongs on the Knowledge row that now carries the same
responsibility, not orphaned where the button used to be.

- [ ] **Step 3: Fix the run deep-link**

`src/agent/RunList.tsx:162-166` navigates
`{ kind: 'status', section: 'fleet', run: entry.durableId }` → becomes
`{ kind: 'knowledge', nav: { tab: 'runs', run: entry.durableId } }`.

Update `src/agent/RunList.test.tsx:141-166`, which asserts that selection
verbatim.

- [ ] **Step 4: Run both tests, then typecheck**

```sh
pnpm test:run src/app/Rail.test.tsx src/agent/RunList.test.tsx && pnpm typecheck
```
Expected: PASS, and typecheck clean.

---

## Task 4: Port the unit tests

**Files:** delete `src/pages/EpistemicStatusPage.test.tsx`; create
`src/knowledge/BaseItself.test.tsx`

`EpistemicStatusPage.test.tsx` has 20 tests mounting the page directly with
`@/lib/ipc` mocked. The page is gone; the sections are not.

- [ ] **Step 1: Port each test to the component it actually exercises**

Mount `WhatChanged`, `WhatsContested`, `WaitingOnYou`, `Background`,
`AgentWork` or `DeferralGates` — whichever the test was really about — keeping
the same mocked-ipc setup (`EpistemicStatusPage.test.tsx:39-54`).

**Every test must survive.** These encode the invariant this whole milestone
rests on: *a read that FAILED renders `section-unavailable`, never the empty
state.* If a test cannot be ported, STOP and report it rather than dropping it.

The one test asserting `sections.map(s => s.getAttribute('data-section'))`
(`:187`) checked the page's section ORDER. There is no single ordering any
more — it becomes an assertion that each component renders its own
`data-section`, one per component.

- [ ] **Step 2: Run**

```sh
pnpm test:run src/knowledge/BaseItself.test.tsx
```
Expected: PASS, with a count equal to or greater than the 20 that existed.

---

## Task 5: Re-point the e2e suite

**Files:** `e2e/boot.ts`, `e2e/status.spec.ts`, `e2e/fleet.spec.ts`, `e2e/review.spec.ts`, `e2e/pipeline-surface.spec.ts`

**The whole point of keeping `data-section`:** only the ENTRY changes. Most
assertions are untouched.

- [ ] **Step 1: Replace the helper in `e2e/boot.ts:87-93`**

```ts
/**
 * Open one of the Knowledge tab's sections.
 *
 * M33a.2 folded the Status hub into Knowledge, so the entry is a nav row
 * rather than a rail button — but the sections still carry `data-section`,
 * which is what every assertion downstream addresses.
 */
export async function openKnowledgeTab(page: Page, row: string) {
  await page.getByTestId('rail').getByRole('button', { name: 'Knowledge' }).click();
  await page.getByTestId('knowledge-nav-row').filter({ hasText: row }).click();
}
```

Keep `openStatusSection` deleted, not aliased — an alias would let a spec keep
claiming it opens something called Status.

- [ ] **Step 2: Update each call site to the new row name**

- `e2e/fleet.spec.ts:64` → `openKnowledgeTab(page, 'Agent work')`
- `e2e/review.spec.ts:59` → `openKnowledgeTab(page, 'Waiting on you')`
- `e2e/pipeline-surface.spec.ts:94` → `openKnowledgeTab(page, 'Background')`
- `e2e/status.spec.ts` — its local `open()` helper (lines 83, 324) becomes the
  same call with the row each test needs.

- [ ] **Step 3: Fix the two nav assertions in `e2e/status.spec.ts`**

The test `'status: the hub carries its own nav, not the record sidebar (M33.10)'`
(line 273) asserts `status-nav-row` has count 5. That nav is gone. Replace the
test with one asserting the Knowledge nav carries the six new rows — same
intent (the tab has its own axes), current mechanism. Rename it to say M33a.2.

Lines 286-288 use `[data-target="fleet"]`. `data-target` no longer exists;
address the nav row by name instead.

- [ ] **Step 4: Check the "no borrowed chrome" test still holds**

`e2e/knowledge.spec.ts:92-146` asserts `sidebar-type` and `collection-node-*`
are absent from Knowledge. The merge adds fleet filters, review cards and a
gate board to this tab — verify that premise is still true, and if the merged
tab now renders something from Home's chrome, that is a real defect to fix, not
a test to relax.

- [ ] **Step 5: Run the suite**

```sh
lsof -iTCP:5173 -sTCP:LISTEN
```
If that prints anything, the port is held by another worktree and
`reuseExistingServer` will silently run your suite against a different branch's
app. Pick a free port: `PORT=5473 pnpm e2e`.

Expected: all pass. 30 tests changed their entry point; none should have
changed their meaning.

- [ ] **Step 6: Commit everything from Tasks 1-5 as one commit**

The type change, the moves and the test updates are one atomic refactor — none
of them compiles alone.

```sh
git add -A
git commit -m "feat(knowledge): the base and what it knows about itself are one tab (M33a.2)"
```

---

## Task 6: Collapse the gates

**Files:** `src/knowledge/BaseItself.tsx` (the `DeferralGates` export)

Per spec D5/D6: R1–R14 was 3,225px of "Never evaluated here" — 55% of the old
page — and it is build-planning bookkeeping, not a reading surface.

- [ ] **Step 1: Write the failing test** in `src/knowledge/BaseItself.test.tsx`

```tsx
it('says how much is held back without listing it', async () => {
  // 24 cards of "Never evaluated here" was 55% of the old Status page. The
  // count is the answer; the board is for whoever asks a second question.
  render(<DeferralGates vaultPath="/vault" />);
  expect(await screen.findByTestId('gates-summary')).toHaveTextContent(/held back/);
  expect(screen.queryByTestId('gate-card')).toBeNull();
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Make the board collapsed by default**

One line — `N capabilities held back, none fired` — expanding on click to the
existing board. Do not delete the board; D6 says this is reversible once it has
been lived with.

- [ ] **Step 4: Run it, watch it pass. Then the full gate:**

```sh
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test:run
cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Then e2e on a verified-free port.

- [ ] **Step 5: Commit**

```sh
git add -A
git commit -m "feat(knowledge): what stays unbuilt says so in one line (M33a.2)"
```

---

## Done when

- The rail has nine buttons and no Status.
- Knowledge's sidebar carries both groups.
- Every section still carries its `data-section`, and every e2e assertion about
  section content is unchanged from before this task.
- No test was deleted to make this pass.
