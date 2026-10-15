# M65 — Keyboard and panes

**Goal.** Every command is defined once, in one catalog that feeds the keymap, ⌘K, keycaps and Settings. g/c chords and list keys work and never steal typing. Back restores view state, and a relaunch lands on the last place. One New launcher creates everything. `cerebro://` links open pages. Writers outside the editor stop overwriting newer bytes. Pages open side by side, with one live editor per file.

Roadmap: `2026-10-12-macro-port-roadmap.md`, § M65. House style and rails: the M53–M64 and M70 plans. M66, M67 and M69 name this plan's pieces by role. Their contracts are kept here: the `*.commands.ts` files, last place, panes, the rename hook and `file` in `placeResolves`.

**Read first (Macro, behaviour only), by part:**

- .1, .1b: `apps/web/src/lib/core/hotkey/{types,hotkeys,state}.ts`, `eclipse-override.test.ts`, `scope-activation.test.ts`
- .2: `apps/web/src/features/command/{CommandMenu.tsx, state.ts}`
- .3, .3b: `apps/web/src/components/list/create-list-controller.ts`
- .4: `apps/web/src/components/navigation-stack/NavigationStack.tsx`, `docs/AGENT_GUIDE/navigation.md`
- .5: `apps/web/src/features/command/{Launcher.tsx, core/create-menu-details.ts, core/launcher-history.ts}`
- .6: `apps/web/tauri/src-tauri/src/lib.rs`, `apps/web/src/lib/tauri/navigation.ts` (buffered, then delivered once)
- .8: `apps/web/src/lib/split-router/{router/claims.ts, panes/history.ts, panes/memory-store.ts, tests/panes.test.ts}`, `apps/web/src/components/app/split-layout/split-router/app-pane-policy.ts`
- .9: `app-pane-policy.ts`, `navigation.md`
- .10: `panes/memory-store.ts`
- .7: none. It is Cerebro's own, on M55.3's pattern.

## Status

- **Precondition:** M53–M57, M70 and M58–M64 are closed, in that order, with green gates and updated roadmap statuses. They are being built unstaged in this checkout, so this plan names their finished functions, never today's lines.
- **Built, unstaged:** .1, .1b, .2, .3, .3b, .4, .5, .6, .7, .8, .9 and .10. `src/lib/keys` and `src/app/commands` now provide one capture dispatcher and catalog; g/c chords, generated keycaps/tooltips/Settings, save and find are integrated. Pane ownership, the visible row, saved layouts and shared rename propagation are integrated. Packaged checks remain owed on the final rebuilt bundle.
- **.1b verification (2026-10-15):** 350 focused unit checks across the keymap, commands, hints, editor and shell pass; three-config typecheck and scoped lint/format checks pass. All eight keyboard browser scenarios, ten column scenarios and find have current passing proof across isolated runs. The chord hint and Settings screenshots were reviewed. Broad parallel HMR interrupted two runs; unchanged isolated retries passed. Packaged WKWebView check awaits the final rebuilt bundle.

- **.2 verification (2026-10-15):** The palette snapshots its opening scope, filters five categories, and provides theme, favorite and agent choosers. Unmatched Enter never asks the assistant. 129 focused checks and all three palette browser scenarios pass; the theme screenshot was reviewed. Scoped lint/format pass. All three TypeScript checks pass with the current integration. The browser run also found and fixed Favorites pruning before the current vault completed its scan, with startup, error and vault-switch regressions. Packaged keyboard proof remains owed.

- **.5 verification (2026-10-15):** The grouped New launcher, per-vault recents, landing details and all eleven creation commands are implemented. Existing dialogs and Library creators are reused; every blank database now seeds starter statuses. 212 focused checks pass across the launcher, catalog, stores, creators, sidebar, Library, App and shortcut rails (211 in the combined gate, plus the new every-command regression); all three TypeScript checks and scoped lint pass. All eight keyboard browser scenarios and both launcher scenarios pass, including collapsed navigation, keyboard scrolling and typing in the page body. The launcher screenshot was reviewed. No commit or staging was performed.


- **.3/.3b verification (2026-10-15):** A shared keyed cursor now drives My work, Concepts, Inbox and Home; TableView selection uses its pure model while retaining its existing keyboard. Peek j/k and focus return preserve one Escape per layer. Home event selection sends the rendered revisions with one exact Undo and stops across vault switches. 386 focused checks, then 17 finishing checks, all three typechecks and scoped lint pass. The 38-scenario surface/state-lab browser run passed 37; its sole failure was a heading-only fixture being deliberately edited by the typing probe. After seeding a body paragraph, all four new keyboard scenarios pass, with persisted typing checked. All seven existing Home scenarios pass. Home and My work screenshots were reviewed. Packaged WKWebView focus/menu checks remain owed.

**.7 verification (2026-10-15):** Non-editor saves compare the loaded whole-file hash, including knowledge captures under the ledger writer lock. Task ticks refresh without retry; Library drafts retain the conflict and offer load or explicit overwrite. 220 focused Rust checks pass with all-target clippy and rustfmt clean. 548 focused TypeScript checks pass across the eight affected suites (545 in the combined run, three added cases in the final gate); the final IPC/conventions/Library/mock/state-lab gate passes all 654 checks. Both browser scenarios pass and the Library conflict screenshot was reviewed. Scoped lint/format pass; shared write-door cases agree in Rust and the browser mock. All changes remain unstaged and uncommitted.

- **.4 verification (2026-10-15):** History slots retain each visit's search, controls and table scroll; deleted destinations are pruned and last places restore only after the correct vault is ready. 590 of 591 shared fixture regression checks passed initially; .6 updated the Open with menu assertion and the entire 65-test DocPage suite now passes. All 57 focused history/page/root checks, all three TypeScript configurations and scoped lint pass. Five browser scenarios pass, including exact scroll restoration, valid and missing last pages, transient peek removal, and Back/Forward across a trashed page. The restored table screenshot was reviewed. Packaged relaunch remains owed. Changes remain unstaged and uncommitted.

- **.8 verification (2026-10-15):** The pure pane engine enforces file and single-place claims over 40,000 seeded transitions; 2,000 store transitions also keep the peek separate. Pane-context selectors/actions, histories/captors, editor holders and Inbox's Show placeholder are integrated. 229 focused model/shell checks and 183 editor/routing checks pass, along with all three TypeScript configurations. All 40 existing history, keyboard, list, Home and shell-layout browser scenarios pass with one pane. CV-52 records the ownership rule. Changes remain unstaged and uncommitted; the visible row follows in .9.

- **.9 verification (2026-10-15):** The visible pane row, modified-click/Shift+Enter opens, capacity and parking, and three catalog commands are integrated. All 28 pane and existing shell-layout browser scenarios pass, including exact zero-width parking and immediate-close save preservation. Browser testing found and repaired focus restoration into an old pane after Quick open reused another pane. Two-pane and parked screenshots were reviewed. Focused component, routing, keymap and capacity tests and all three TypeScript checks pass. Packaged WKWebView and native menu checks await the final bundle.

- **.10 verification (2026-10-15):** Per-vault layouts restore once after scanning, prune dead or duplicate claims, and yield to pending deep links or navigation already made by the person. Rename and Undo move pane history, favorites, recents and last place through one hook, with pruning held across the write. All three new browser scenarios pass, alongside five history, four deep-link and five rename/Undo regressions. Restored-layout and renamed-pointer screenshots were reviewed. The final combined pane/keymap suite passes 160 checks; persistence, rename and convention suites pass 52 checks, with App and Sidebar integration also green. Three-config typecheck and scoped lint/format pass. CV-53 records shared pointer propagation. Packaged relaunch and native menu checks await the final rebuilt bundle; no staging or commit was performed.

  All 10 roadmap parts build. .1 and .3 split by their own bullets, giving 12 parts.
- **Effort:** 3 M + 9 L ≈ 10.5 L; the roadmap said ≈6.3 L. Re-measured:
  - .1: L → L + L (.1b);
  - .3: M → L + M (.3b);
  - .4, .5, .6 and .10: M → L;
  - .7: S → M.
- **Crash risk:** none. No part adds a spawn, a crash point or a schema step.
- **Packaged checks (owner):** .1, .1b, .3, .4, .6, .9, .10. **Live checks:** none, because no part runs the claude CLI.
- **Schema steps:** none. **New refusal codes:** none; .7 reuses `stale_content`.
- **New CV ids:** four (.1, .6, .8, .10). .7 amends M55.3's.
- **Artifacts:**
  - `shared/policy/README.md`: text only (.7).
  - `src-tauri/fixtures/deep-link-payloads.json`: new (.6).
  - `write-doors.json`: two rows (.7).
- **New dependencies:** none. **demo-vault:** untouched; specs seed `__cerebroMockFs`.
- **Closes left-open items:**
  - M60's "M65's registry later absorbs `useUndoShortcuts`" (.1);
  - M59's "⌃F is taken inside pages" (.1, .1b);
  - M64's `e` for Home's Done (.3b). ⌘Z stays off Done, per M64 Q27;
  - M64 Q9's body-write guard (.7);
  - M61's "⌘Enter is composer-local until M65's registry": it stays local (Q6).

- **.6 verification (2026-10-15):** App links are parsed and buffered in Rust, resolved only through the read-only vault registry, and delivered after the listener and scan are ready. Linked records open as full pages so Back returns to the exact record. 161 focused TypeScript checks and 64 focused Rust checks pass (the Rust gate also includes bytes containment and project-run queries); all three TypeScript configurations and scoped lint pass. Four browser scenarios pass, including cold PRD navigation over a stored last place, one starting history entry, no-create refusals, a cross-vault confirmation, and live navigation. The confirmation screenshot was inspected; a live browser probe recorded zero vault writes. Rustfmt and the final all-target clippy pass are clean. LaunchServices cold-start delivery and the copied link across real registered vaults remain packaged checks. All changes remain unstaged and uncommitted.

## Decisions

- **Owner decisions** (roadmap, 2026-10-12), as they bind M65:
  - D0: Macro is read for behaviour only. No copied code, names, comments or fixtures.
  - D1: single user. The keymap, launcher recents, last place and pane layout are this viewer's conveniences, per vault and on this Mac (localStorage, try/catch). They are never records.
  - D2 (c): .7 lets `save_note` writers outside the editor carry `expect_hash`. Home task ticks and the Library send the hash they read, and a mismatch refuses as `stale_content`. Human saves from the editor stay last-write-wins.
  - D3 (a): one shape file, no rule twin. .6's payloads are parsed in Rust alone and read by TS as a shape check. .7's save words are held by `write-doors.json`. The keymap, cursor, panes and launcher are TS-only.
  - D4 (a): no transport change. D5–D7: untouched.
  - D18: every open is still a page. Panes are page panes. Launcher rows, deep links and palette choosers open pages, and every creation round-trips as files.
  - **Governed types hold:** M65 adds no agent writer. The launcher's agent and database rows are human doors: agents are born paused, and databases go through `createDatabase`. An agent's `open_note` focuses a holding pane silently.
- **D8+, default taken** (the roadmap's recommendation):
  - **D11 (b):**
    - a scoped keymap with g/c chords and list keys;
    - page panes with per-pane history, and claims keyed by file path;
    - Escape stays with `layers.ts` (`src/components/ui/layers.ts`);
    - ⌘-click opens a pane, because Shift-click already extends selection.

    This leaves M16's Notion premise and reverses M16.39 ("one shortcut is cheaper than a command mode"). Cite that in .1's review.
  - D9 (b), as M64 took it: `e` marks only event rows Done (.3b). Home gains no count.
  - D10 (b), as M70 took it: a thread is a lens. A relaunch drops it (.4), and claims ignore it (.8).
  - D12 (b), as M64.5 took it: the macOS 14 floor gives WKWebView container queries and `inert` (.9).
- **Global uiStore state** (roadmap risk), decided by default:
  - the record peek belongs to one owning pane;
  - a diff belongs to the pane showing its page;
  - the doc panel's open state and tab stay global preferences, which M52's asides fold by pane width;
  - Inbox and Work stay single (.8).
- **Rules:**
  - One part, one commit: `type(scope): sentence (M65.n)`. Each commit deletes the comments it falsifies (CV-11).
  - Build as M53–M64 are built: unstaged in the main checkout, each part confined to its declared files, never touching the index. Each part's commit message goes in its build report.
  - Edits anchor by name or text, never line number.
  - The waves are fixed, and parts in a wave share no file. Each e2e run gets its own free `PORT`. cargo runs one at a time, always with the skip list.
  - Schema: none. A step found necessary takes the next free `user_version` at build time.
  - Refusal codes: none. A new one goes through policy.v3's README ritual. Never run prettier over `shared/`.
  - Specs boot through `e2e/boot.ts` with the clock pinned (CV-15) and scope destination clicks to `nav-surfaces`. Chord and hint timers use `setTimeout`, never `Date.now`, because e2e pins `Date`.
  - Editor parts (.1, .1b, .8, .9) read the BlockNote DOM traps first (`verify-ui`). Trap 9: pointer events inside custom blocks never reach React, but click does. Trap 10: chips vanish in an unmount flush.
  - No part runs the claude CLI. Packaged checks are the owner's.
  - No new reading section, so M64.1's five-preset CV adds no lab file. Settings' shortcut list reads the static catalog, not IPC. M64's Home presets must keep passing (.3b).
- **Contracts between parts.** Whichever part lands second does the shared work:
  - **One catalog (.1).** A command is a row in `src/app/commands/<area>.commands.ts`, loaded by eager `import.meta.glob`. Parts add a file and never edit `index.ts`. `GROUPS` already lists Create and Panes; a file may declare its own group, which Settings appends in file order. A row may name any scope: app, page, peek, or an inner scope (`block`, `viewer`, `sheet-grid`) that nests under page or peek and reuses an outer key only with `shadows`. M66's viewer keys add their own file.
  - **Inner scopes (.1 → M66, M67).** M66's viewers bind in a `viewer` scope, so ⌘9/⌘0 beside Work's `mod+1…9` and ⌘F/⌘G beside .1b's find rows shadow instead of clashing; M66.5's PDF keys declare their own group. M67's grid binds `sheet.undo/redo` rows with `shadows` in `sheet-grid`, in place of M60.7's claim, which .1 deletes. Focusable non-editable roots (the grid, a viewer) carry `data-key-claim="typing"`, since `stopPropagation` no longer shields keys from the capture-phase root.
  - **Chords (.1b → .3, .5).** `g g` is reserved for `list.first` (.3). .1b's stopgap `create.page`, `create.database` and capture's `c n` are taken over by .5:
    - `c n` moves to `create.launcher`, and capture becomes `c i`;
    - .5 rewrites `create.commands.ts`, drops .1b's create bindings from `useAppCommands`, and updates keyboard.spec's `c p` case.
  - **One cursor (.3).** `useListCursor` serves Home (.3b, keys read from the DOM), the peek step per pane (.8) and ⇧↵ (.9's `list.openBeside` row in `list.commands.ts`).
  - **One history (.4).** Slots are `{selection, byAgent, state?}`.
    - .8 reuses `stepLive` with a skip predicate for held entries, and keys `registerEntryCaptor` by pane.
    - .10 reuses `readSelection` and `placeResolves`.
    - .6 makes the restore yield to a pending link. .10 moves the restore into its one restore point and keeps that precedence.
  - **One claim rule (.8).** `claimOf` and `MAX_PANES` serve .9's opens and .10's prune.
  - **One page scope per pane (.9).** The page key scope moves from `<main>` onto each pane frame, and root.ts's fallback picks the active pane's.
  - CV ids go in wave order: .1, .6, .8, .10. New commands land with their adapter calls (M54.3): .6 adds two plus one event, and .7 changes one.
- **Scout reconciliations** (no part changed wave):
  - .5's `create.ts` and .9's `panes.ts` become `create.commands.ts` and `panes.commands.ts`, so neither edits `index.ts`.
  - A diagram's undo can't bind the app's `undo` in a page scope, since a def binds only in its own scopes. It gets `diagram.undo/redo` rows (scopes page, peek and block, `shadows`), so `CommandDef.scope` takes a list.
  - FindBar's Escape layer registers `modal: false`. Otherwise the modal rule would stop ⌘G in its own input. The find rows are all `inEditor` (M59.6 steps from that input).
  - .9 gains `root.ts` (the active pane's fallback, flagged by .1's scout) and `list.commands.ts`.
  - .10 gains `lastPlace.ts` and `LastPlaceHost.tsx`, because .4 put last place outside navStore.
  - .8 gains `navHistory.ts`.
  - .5 depends on .1b.
  - QuickOpen's "Open beside" footer renders its keycap through `Keycaps`, which .1b's glyph scan requires.

## Waves

| Wave | Parts | Theme |
| --- | --- | --- |
| 1 | M65.1 | keymap core, scopes, editor claims, first migrations |
| 2 | M65.1b | chords, keycaps, Settings list; ⌘S and ⌘F join |
| 3 | M65.3, M65.2 | list cursor and peek keys · palette commands |
| 4 | M65.3b, M65.4 | Home's cursor and `e` · view state in history, last place |
| 5 | M65.5, M65.6 | New launcher · `cerebro://` links |
| 6 | M65.7 | `save_note` guard outside the editor |
| 7 | M65.8 | pane model |
| 8 | M65.9 | pane row |
| 9 | M65.10 | layout per vault, one rename hook |

**Before wave 1:**

- Commit this plan on M64's closed tip.
- Re-read the finished names it leans on:
  - M53: .12 (link guard), .14 (`isPlace`), .20 (engine rail, `setup.ts`), .24 (log macros).
  - M55: .3 (`rewrite_note`, `NoteWriteError::Stale`, `parse_expect_hash`), .6 (NoteBodyEditor), .9 (OpenWithMenu, `writeClipboard`, `canOpenOutside`), .10 (menu, `pageWrite`), .12 (`navigate(…, {replace})`), .13 (`addSubPage`, `canHaveSubPages`).
  - M58.1: receipts, `write-doors.json`, `__cerebroMockWrites`.
  - M59: .1 (`DESTINATIONS`, `navigateTarget`, `placeLabel`), .3 (open log, `byAgent`, `rankNames`, `nameMatches`), .4 (highlight rule), .6 (FindBar registry).
  - M60: .6 (stale row under surface `batch`), .7 (`useUndoShortcuts` and its claim, `undoStore`, toast action), .8 (Trash), .10/.10b (`readNoteSource`, `renameKeepingLinks`, renameActions), .11 (`renameDatabase`).
  - M61: .3b (`workSections`), .5 (`CsvImportDialog`), .6 (RecordComposer, NewRecordDialog).
  - M64: .1 (lab, its CV), .3 (marks), .4/.4b (`HOME_LANES`, `Lane.tsx`, `useHomeDone`), .9 (RecipesOffer on the Library).
  - M70.2b: the `thread` lens.
- Ask each wave's questions before it starts. The default applies if unanswered.

**Roadmap acceptance, by part:**

| Roadmap bullet | Parts |
| --- | --- |
| g h opens Home, letters typed in the editor still type, and Settings lists exactly the registered bindings | .1b on .1 |
| On Home, j/k move and e marks Done | .3b |
| j/k steps the peek from My work | .3 |
| Back returns a table to its scroll position and filter, and relaunch lands on the last place | .4 |
| ⌘-clicking a link opens a second pane; opening the same file from the first pane focuses the second; closing the last pane goes Home | .9 on .8 |
| Reload restores both | .10 |
| `open "cerebro://open?…"` from a terminal opens the page exactly once on a cold start | .6 (packaged) |

.2, .5 and .7 answer their own roadmap rows.

## Parts

### M65.1 Keymap core: one capture-phase listener, focus scopes, editor claims, and the first migrations

- **What:** there is no keymap. App.tsx's window listener (⌘K ⌘J ⌘⇧N ⌘⇧L ⌘[ ⌘]) loses keys to React's `stopPropagation` (M29.53), and ⌃ fires app shortcuts on macOS. Split by size: this part holds the engine plus five migrations (App.tsx, useUndoShortcuts, useDiagramFile, useWorkspaceKeys and Inbox ⌘E). .1b adds chords, keycaps and Settings.
- **Files:**
  - new: `src/lib/keys/{combo,claims,registry}{,.test}.ts`, `src/lib/keys/{root,useKeys}.ts` plus `{root,useKeys}.test.tsx`, `src/lib/keys/keydownRail.test.ts`, `src/app/commands/{index,index.test,app.commands,work.commands,inbox.commands}.ts`, `src/app/useAppCommands{.ts,.test.tsx}`, `e2e/keyboard.spec.ts`;
  - shell: `src/{App,App.test}.tsx`, `src/app/useUndoShortcuts{.ts,.test.tsx}`, `src/app/{Sidebar,StatusBar,ToastHost}.tsx`;
  - mermaid: `src/mermaid/{useDiagramFile,keys}.ts`, `src/mermaid/MermaidBlockView{,.test}.tsx`, `src/mermaid/flowchart/StructuralEditor.tsx`, `src/pages/DiagramPage.test.tsx`;
  - other: `src/workspace/useWorkspaceKeys{.ts,.test.tsx}`, `src/pages/InboxPage{,.test}.tsx`, `src/components/ui/layers{,.test}.ts` (test new), `src/detail/DetailPanel{,.test}.tsx`, `src/test/setup.ts`, `AGENTS.md`.
- **Approach:**
  - **Specs and claims (pure).**
    - combo.ts parses specs (`mod+shift+k`, `shift+g`, `enter`, chord `g h`). `parseKeys` refuses any Escape, empty parts and unknown modifiers.
    - On macOS `mod` is ⌘ alone and ⌃ is `ctrl`. Elsewhere mod is Ctrl or ⌘, so jsdom and Linux CI's ControlOrMeta keep working.
    - `keyOf(e)` takes one ASCII char from `e.key`, else `e.code`. Digits and punctuation under Shift or Option also use the code, so `{` matches `mod+shift+[`. Modifiers must match exactly.
    - claims.ts takes `EDITOR_MOD_KEYS` and `claimedByHostEditor` unchanged; mermaid/keys.ts re-exports them, so its six importers stay put. `claimsOf(el)` unions every ancestor's `data-key-claim`:
      - `typing` claims every key without ⌘ ⌃ ⌥;
      - `editor` claims typing plus ⌘/⌃ with z y b i u a enter;
      - an editable target claims `editor`.
  - **Catalog** (`src/app/commands/`).
    - `CommandDef {id, label, keys[], scope (app, page, peek, any inner scope name, or a list), group, inEditor?, inModal?, desktopOnly?, palette?, aliases?, shadows?}`.
    - Eager glob of `./*.commands.ts`. `GROUPS`: General, Go to, Create, Pages, Panes, Lists, Record peek, Home, Inbox, Work. A file may export its own `group`; Settings appends those after `GROUPS`, in file order.
    - The load check throws on: a duplicate id; an unparsable key; any Escape; a key used twice in one scope; an inner key equal to an outer one without `shadows` (page and peek sit under app, any other scope under page or peek); a letter marked inEditor or inModal; an inEditor command on an editor key.
    - Rows: Appendix A.
  - **Registry, root and hooks.**
    - registry.ts: the newest binding of an id eclipses older ones until disposed. A def binds only in its listed scopes. The lookup walks innermost first, and a false `when` falls to the parent, never back to an eclipsed binding. Also `availableCommands(chain)`, `runCommand(id, chain)`, `subscribe` and `resetKeymap()`.
    - root.ts `installKeyRoot()` adds one window-capture keydown listener. It records the nearest `[data-key-scope]` on focusin and pointerdown, since WKWebView never focuses a clicked button; `[data-key-neutral]` records nothing.
    - `activeChain()`: the focused element's scope, else the recorded one, else `[data-key-scope-page]`, then up to app.
    - Dispatch skips `isComposing`, keyCode 229, bare modifiers and claimed keys.
      - Letters stand down on editable targets and under `hasModalLayers()`.
      - Modifier commands stand down on editable targets unless inEditor, and under modal layers unless inModal.
      - desktopOnly needs `__TAURI_INTERNALS__`.
      - A handled key is prevented and stopped; an unhandled key is untouched.
    - useKeys.ts: `useKeyRoot`, `useKeyScope(name, {page?})`, `useCommand(id, run, {when, scope})` and `useCommands(list)`. They bind in a layout effect and hold the latest handlers in refs, so a re-render never reorders the eclipse.
  - **Migrations.**
    - App.tsx: the keydown effect goes. `useKeyRoot()` and `useAppCommands()` run above the vault early return, so ⌘⇧L works at the chooser. `<main id=main>` is the page scope. useAppCommands binds General with App.tsx's handlers moved verbatim.
    - Undo: useUndoShortcuts becomes `useCommands([undo, redo])` with `when: () => !hasLayers()`, and the claim API goes. useDiagramFile binds `diagram.undo/redo` in its scope, replacing M60.7's claim.
    - Block scope and claims: MermaidBlockView's root (`mermaid-block`, which holds Edit) is its own `block` key scope, and the block binds `diagram.undo/redo` on it while editing, so one block never eclipses another. M29.53 measured focus on BODY right after Edit, where no claim lies on the target's path; the scope recorded on pointerdown now takes ⌘Z there, never the app's undo. The editing root still claims `editor`, and the block's document listener keeps Escape and the ⌘Z that claims hold back. StructuralEditor's root claims `typing`.
    - useWorkspaceKeys becomes `useCommands(enabled ? WORK : [])`. Inbox ⌘E becomes `useCommand('inbox.file', …, {when: a capture is open})`.
    - layers.ts gains `LayerOptions.modal` (true by default for surfaces) and `hasModalLayers()`. DetailEscapeLayer registers `modal: false`, and the panel root is the `peek` scope.
    - The Sidebar navs, StatusBar and ToastHost get `data-key-neutral`. setup.ts installs the root once and resets the keymap after each test.
  - **Rail and CV.** keydownRail.test scans non-test src for window and document keydown listeners. Each one outside src/lib/keys is listed with its count and reason:
    - Escape layers, focus traps, gestures and editor-internal keys;
    - the raw Escape listeners: InlineDiff, ViewTabs, RecordTabs ×2 and CreateMenu (Q2);
    - M55–M64's own, with their plans' reasons;
    - NoteBodyEditor ⌘S and FindBar ⌘F, until .1b.

    AGENTS.md takes the next free CV (Appendix B), and the repo map gains `src/lib/keys` and `src/app/commands`.
- **Comments to delete:**
  - App.tsx's keydown comments. The capture and theme reasons move to useAppCommands. Delete M16.39's "one shortcut is cheaper than a command mode" and "M16's whole point is that Notion…". The ⌘[ ⌘] typing reason moves to its row.
  - keys.ts' MEASURED starvation paragraph. Rewrite: the keymap listens in capture, and this rule is its default host-editor claim.
  - useWorkspaceKeys' `typing()` doc.
  - InboxPage's "Bound once per selection…" and its field-guard comment.
  - M60.7's claim docs in useUndoShortcuts and useDiagramFile. Keep the "clicked `<g>`" reason.
  - MermaidBlockView's onUndo doc ("routes the key itself… exactly as `useDiagramFile` does"): the block binds `diagram.undo/redo` in its scope, as useDiagramFile does in its page.
  - layers.ts' `hasLayers` doc gains `hasModalLayers`.
- **Tests:**
  - combo: parsing and refusals; mod on mac and elsewhere; ⌃K on mac isn't mod+k; ⌥⌘F by code; `{` as ⇧⌘[; a non-Latin layout falls back to the code; keycaps on both platforms; chords.
  - claims: editable targets; ancestor unions; typing vs editor; M29.53's cases unchanged.
  - registry: Macro's three eclipse cases, in our words; inner before app; a false `when` falls to the parent; an unknown id and a scope mismatch throw; reset.
  - root:
    - a component that stops every keydown no longer silences ⌘K (M29.53);
    - letters stand down in input, textarea, select, contenteditable, a claim and a modal layer, but not beside a `modal: false` layer;
    - composition is ignored; handled keys are prevented and unhandled keys untouched;
    - focusin, pointerdown, neutral chrome, body and a removed scope each pick the right scope; desktopOnly.
  - useKeys: mount and dispose; the latest closure runs; a re-render keeps the eclipse order.
  - index.test: `no command binds Escape`; unique ids; one key per scope; `shadows` required, inner scopes included; a file's own group follows `GROUPS`; no letter inEditor or inModal; no inEditor editor key; every keyed command has a binding site (source scan).
  - layers.test: `modal` defaults to true; a `modal: false` layer counts for `hasLayers` only.
  - useAppCommands.test: each old handler; a failed capture toasts.
  - App.test: every key case passes unchanged; `<main>` carries `data-key-scope-page`.
  - useUndoShortcuts.test: M60.7's cases, with "a diagram's own binding shadows it".
  - DiagramPage.test: ⌘Z undoes the diagram, and undoStore is untouched.
  - MermaidBlockView.test: ⌘K passes; ⌘Z runs only the block's undo; after Edit with focus left on body, ⌘Z runs `onUndo` and undoStore is untouched; with two blocks, the edited one's undo runs.
  - useWorkspaceKeys.test passes unchanged.
  - InboxPage.test: ⌘E files; in the body or with nothing open, it is not prevented.
  - DetailPanel.test: the peek's layer is non-modal, and Escape still closes it.
  - e2e keyboard.spec:
    - ⌘K from a focused mermaid source box opens the palette;
    - edit a table cell, then Edit a mermaid block, add a node, `blur()` to body and press ⌘Z: the node leaves the file and the cell edit stays;
    - ⌘J works while typing in a page;
    - ⌘[ in a page body stays put; on the page chrome it goes back;
    - Inbox ⌘E files the open capture, but not while typing in its body.
- **Acceptance:**
  - Roadmap: scopes activate on focusin (and on pointerdown), and a later binding eclipses until disposed.
  - Roadmap: the capture phase honours host-editor claims. A blanket `stopPropagation` no longer silences ⌘K, and a mermaid block's ⌘Z never also runs the app's undo, even with focus left on body after Edit.
  - Roadmap: letters stand down in modal layers and editors, with `isComposing` guarded. Escape stays with `layers.ts`, and no command binds it. The docked peek isn't modal.
  - Roadmap: App.tsx, useWorkspaceKeys and Inbox ⌘E migrate first, and App.test's key cases pass unchanged.
  - A diagram page's ⌘Z undoes the diagram, and a focused table's ⌘Z undoes the last batch (undo.spec passes).
  - On macOS only ⌘ is mod (Q1).
  - Every remaining listener is listed with a reason. No Rust, IPC, mock, schema, code or artifact changes.
- **Packaged check (owner):**
  - ⌘K ⌘J ⌘⇧N ⌘⇧L ⌘[ ⌘] work as before, and ⌃K edits a text line.
  - ⌘Z off a field undoes the last batch; in a page body it undoes typing; right after a mermaid block's Edit it undoes the block.
  - ⌘W in Work closes the tab, not the window. If the menu wins, a menu event drives the same handler, M60.7's fallback.
  - An IME composition triggers nothing.
  - After a row click, ⌘E and ⌘\ reach that page.
- **Wave** 1 · **Depends** M53.20; M59.1, .6; M60.7; M64.1 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(shell): one keymap dispatches app shortcuts in the capture phase, behind editor claims (M65.1)`.

### M65.1b g and c chords, keycaps in tooltips, and Settings → Keyboard shortcuts generated from the catalog

- **What:**
  - there are no chords and no keycap component;
  - hints are hard-coded: Sidebar "Search ⌘K" ×2, Inbox's ⌘E kbd and title, DocPage's ⌘S title, and the ⌘Enter hints in M61.6's RecordComposer, M58.5's DiffNotes ("Add note (⌘Enter)") and M70.2b's CommentComposer;
  - Settings has no shortcuts list (M9.6 #7 never built);
  - NoteBodyEditor ⌘S and FindBar ⌘F (M59.6) are still window listeners.
- **Files:**
  - new: `src/lib/keys/chords{,.test}.ts`, `src/app/commands/{go,create,page}.commands.ts`, `src/app/ChordHint{,.test}.tsx`, `src/components/ui/Keycaps{,.test}.tsx`, `src/pages/KeyboardShortcutsSettings{,.test}.tsx`;
  - keys and commands: `src/lib/keys/{root.ts, root.test.tsx, keydownRail.test.ts}`, `src/app/commands/{index,index.test,app.commands}.ts`, `src/engine/destinations{,.test}.ts`, `src/app/useAppCommands{.ts,.test.tsx}`;
  - surfaces: `src/App.tsx`, `src/components/ui/Tooltip{,.test}.tsx`, `src/app/Sidebar{,.test}.tsx`, `src/pages/SettingsPage{,.test}.tsx`, `src/pages/InboxPage{,.test}.tsx`, `src/pages/DocPage.tsx`;
  - hints (added on review): `src/app/RecordComposer.tsx`, `src/git/DiffNotes.tsx`, `src/detail/CommentComposer.tsx`, and every file the build-time glyph grep finds;
  - editor: `src/editor/NoteBodyEditor.tsx`, `src/editor/openPages{,.test}.ts`, `src/editor/FindBar{,.test}.tsx`;
  - `e2e/keyboard.spec.ts`, `AGENTS.md`.
- **Approach:**
  - **Chords.**
    - chords.ts holds one pending chord `{leader, chain, hintShown}`. `HINT_MS` 200 and `RESET_MS` 2000 run on `setTimeout`.
    - root.ts resolves a pending chord before the scope walk. A hit runs and is consumed. A miss cancels, and is swallowed only once the hint shows (Q5).
    - Escape cancels and is never consumed. Blur, pointerdown and a new modal layer also cancel.
    - A leader is a letter that starts a chord in the chain and has no single binding. Letter stand-down applies, so `g` typed in an editor types. Arming consumes the leader.
    - Checks: a leader is never a single binding in its scope or app; second keys are unique per leader per scope.
  - **Rows.**
    - destinations.ts rows gain a `go` letter (Q3, Appendix A) and `GO_KEYS`. go.commands.ts derives `go.<id>` `g <letter>` from them.
    - create.commands.ts holds `c p` and `c d`, a stopgap that .5 takes over (Q4). capture.new gains `c n`.
    - page.commands.ts: page.save ⌘S, find.open ⌘F, find.replace ⌥⌘F, find.next ⌘G and find.prev ⇧⌘G, all inEditor and none inModal.
    - useAppCommands binds them:
      - go.* navigates to the row's selection, and go.inbox follows `inboxEnabled`;
      - create.page runs `createPageIn('')`, then openPath;
      - create.database runs `createDatabase('Untitled database')`, then opens it;
      - page.save runs `flushOpenPages()` when `hasOpenPages()` (new).
  - **The last listeners join.** NoteBodyEditor's ⌘S listener goes; page.save flushes every open page, as each listener did. FindBar's window listener becomes `useCommands` in app scope, with M59.6's `when` and targeting unchanged. Its Escape layer registers `modal: false`, so ⌘G steps from its input. Both leave the rail's allowlist.
  - **Keycaps and hints.**
    - `Keycaps.tsx` renders `<kbd>` parts with `data-keys`: a digit run as a range, alternatives joined by "or", a chord as two groups. `keycapText(id)` gives the text form. Any spec renders, so dialog-local hints (M61.6's ⌘↵) use it too.
    - Tooltip gains `command?`: the label, then the keys. An unknown id throws.
    - `ChordHint` (`chord-hint`, role status) lists the leader's options 200 ms after it, and mounts beside ToastHost.
    - Sidebar: Search and Assistant use Tooltip with palette.open and assistant.toggle, in both header variants. Destination rows and doors show their g chord.
    - Inbox, DocPage and the three ⌘Enter hints use Keycaps or `keycapText`.
    - The rail adds a scan: no ⌘ ⇧ ⌥ ⌃ glyph in a string literal or JSX text outside src/lib/keys and Keycaps.tsx. Before building, grep non-test src for the four glyphs in literals and JSX text; every file that hits joins this part's list and moves its hint the same way.
  - **Settings.**
    - `KeyboardShortcutsSettings` (`settings-shortcuts`, id `keyboard-shortcuts`) goes before About. Its copy is in Appendix B.
    - Groups follow `GROUPS`, then file-declared groups in file order. Each `shortcut-row` (`data-command`) shows the label, every key and a "Desktop app" tag when desktopOnly.
    - AGENTS.md: the destination sentence names the g letter, and .1's CV adds that Settings renders the catalog.
- **Comments to delete:**
  - NoteBodyEditor's ⌘S comment moves to its row.
  - FindBar's "`metaKey || ctrlKey`", "Not hasLayers()…" and any "⌃F is taken" line become row flags and the modal rule.
  - The rail's two "until M65.1b" entries go.
  - Every hard-coded hint (strings) goes.
- **Tests:**
  - chords (fake timers): the hint at 200 ms and the reset at 2 s; a hit is consumed; a miss before the hint passes and after it is swallowed; Escape cancels and passes; blur, pointerdown and a modal layer cancel.
  - root:
    - `g h` resolves through the chain;
    - `g g` resolves in a stand-in page scope that binds list.first;
    - a leader stands down in contenteditable and under a modal layer.
  - index.test: the chord rules; g and c are never single bindings.
  - destinations.test: go letters are unique, one character each, never g; every nav row has one.
  - useAppCommands.test:
    - go.home navigates;
    - go.inbox stands down with the Inbox off;
    - `c p` creates and opens Untitled;
    - `c d` creates a database and opens it;
    - ⌘S flushes, and is not prevented with no page open.
  - openPages.test: `hasOpenPages`.
  - FindBar.test: every M59.6 case passes through the root; ⌃F on macOS doesn't open the bar; ⌘G steps from the bar's input.
  - Keycaps, Tooltip, ChordHint (Top of list only where a list binds `g g`), Sidebar (M43 names unchanged; no glyph in any title).
  - KeyboardShortcutsSettings: rows equal `keyedCommands()` in order, with `data-keys`. SettingsPage, InboxPage, the rail.
  - e2e keyboard.spec:
    - g then h reaches `Home — Cerebro`;
    - `gh` typed in a page body types;
    - g, a 300 ms wait, then x is swallowed;
    - g then Escape hides `chord-hint`;
    - c then p opens `Untitled — Cerebro`, and the mock fs holds `untitled.md` with `# Untitled`;
    - g then comma opens Settings, listing go.home (`g h`) and palette.open.
- **Acceptance:**
  - Roadmap: g h opens Home, letters typed in the editor still type, and Settings lists exactly the registered bindings. Rows equal `keyedCommands()`, and each has a binding site.
  - Roadmap: g and c chords, with keycaps in tooltips.
  - The hint shows at 200 ms and the chord resets at 2 s. A fast non-chord key passes, and Escape cancels and passes on.
  - ⌘F ⌥⌘F ⌘G ⇧⌘G and ⌘S run through the registry. ⌘S flushes every open page, and ⌃F is free inside pages on macOS.
  - No hard-coded glyph remains, and one table holds the destinations and their g letters.
  - D18: c p's page opens as a page and round-trips as a file.
- **Packaged check (owner):** g h and c p work in WKWebView. The hint draws above the status bar. ⌘F and ⌘S reach the page with the Edit menu present.
- **Wave** 2 · **Depends** M65.1; M58.5; M59.1, .3, .6; M60.8; M61.6; M64.6; M70.2b · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(shell): g and c chords, keycaps in tooltips, and a Keyboard shortcuts list generated from the catalog (M65.1b)`.

### M65.2 Palette commands: registry rows with keycaps, Tab-cycled category chips, and nested choosers

- **What:** ⌘K (as M59 leaves it) has no commands, categories or levels. A query that matches nothing highlights the Ask row. The input isn't a combobox, and `Input.tsx` can't pass ARIA. SHELL-4.
- **Files:**
  - new: `src/app/palette/{model,commandRows,choosers}{,.test}.ts`, `src/app/commands/palette.commands.ts`, `e2e/palette-commands.spec.ts`;
  - changed: `src/app/QuickOpen{,.test}.tsx`, `src/components/ui/Input{,.test}.tsx` (test new), `src/hooks/useTheme{.ts,.test.tsx}`, `src/app/useAppCommands{.ts,.test.tsx}`.
- **Approach:**
  - **Model** (pure). Five categories with chips (Q7):
    - Recent, note targets and In pages rows are pages;
    - types and legacy lists are databases;
    - Go to rows are places;
    - command and chooser rows are commands;
    - Ask shows in every category.

    Also `cycle`, `filterRows`, and `defaultActive` (the first option that isn't Ask, else −1). A level is root, or a chooser that saves the root query and highlight.
  - **Rows.**
    - commandRows come from the open-time snapshot of `availableCommands(chain)`, palette:false excluded, plus three choosers: Change theme…, Open favorite… and Open agent….
    - They rank through M59.3's `rankNames` over label and aliases: at most 5 in All, uncapped under Commands.
    - Choosers:
      - theme: Light, Dark and System. A highlight previews and Enter commits;
      - favorites: missing paths are skipped;
      - agents: from `listAgents`, with @handle and a paused tag.
    - useTheme gains `previewTheme(mode | null)`, which writes neither uiStore nor localStorage.
  - **QuickOpen.**
    - The open body mounts while visible. Its useState initializers snapshot `activeChain()` and `availableCommands` before autofocus and before the Dialog's layer registers, so ⌘K offers what was live where it was pressed.
    - A chip tablist sits under the input. Tab and ⇧Tab cycle it, rows take tabIndex −1, and the category resets to All on open.
    - A typed query shows Ask, M59.3's names, a Commands group (`data-section="commands"`, `quick-open-command` rows with Keycaps), then M59.4's In pages. Go to rows show their g chord.
  - **Levels and highlight.**
    - Enter on a chooser pushes it.
    - Escape, or Backspace on an empty query, steps back, restoring the query, the highlight and any preview. Escape at root closes; M29.53's `stopPropagation` stays.
    - Closing from a chooser restores the preview.
    - The default highlight is never Ask. With only Ask showing it is −1: Enter does nothing and ↓ reaches Ask (Q8).
    - An untouched empty default adopts the first late row that isn't Ask. A moved highlight never moves (M59.4).
  - **ARIA and the one new command.**
    - Combobox ARIA goes through Input: role, `aria-expanded`, `aria-controls`, `aria-autocomplete="list"` and `aria-activedescendant`. Options carry ids and `aria-selected`, and groups are labelled.
    - palette.commands.ts adds `shortcuts.show` (no keys), which opens Settings at `#keyboard-shortcuts`.
    - Command rows run after the palette closes, through `runCommand(id, chain)`.
- **Comments to delete:** QuickOpen's "With nothing else to offer, the ask row takes the highlight…". Keep "pinned, not preferred" and M59.4's rule. The Target docblock gains commands and choosers, and the M29.53 Escape comment gains the step back.
- **Tests:**
  - model, commandRows, choosers: categories, ranks, caps and empty lines.
  - useTheme: a preview writes nothing, and null restores.
  - Input: the ARIA passthrough.
  - QuickOpen:
    - chips with Tab;
    - `theme` shows Switch light and dark with `data-keys` `mod+shift+l`;
    - a preview, then Escape, Backspace and Enter;
    - favorites and agents open their pages;
    - the combobox wiring;
    - `zzqx` leaves no active option, Enter runs nothing and ↓ highlights Ask;
    - late rows; M59.4's moved highlight;
    - File the open capture shows only from a stand-in scope that binds inbox.file.
  - useAppCommands: shortcuts.show.
  - e2e palette-commands:
    - Tab cycles the chips and filters;
    - a theme preview sets `html[data-theme=dark]` while `cerebro.themeMode` stays light, Escape restores it, and Enter on Dark commits;
    - Open favorite… opens a starred page;
    - `zzqxv` then Enter keeps the palette open and asks nothing, while ↓ then Enter asks;
    - on Inbox with a capture open, `file` offers File the open capture with its keycap; on Home it doesn't.
- **Acceptance:**
  - Roadmap: registry rows with keycaps, Tab-cycled chips, and nested choosers for theme preview, favorites and agents. Esc and Backspace step back a level, the ARIA is a combobox's, and Ask is never the default highlight.
  - Commands offered are the ones live where ⌘K was pressed.
  - A preview writes nothing until Enter.
  - D18: a favorite or an agent opens as its page.
  - M59's palette tests pass.
- **Wave** 3 · **Depends** M65.1, .1b; M59.1, .3, .4; M55.12 · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(search): ⌘K runs commands, cycles categories with Tab, and opens nested choosers (M65.2)`.

### M65.3 A keyed list cursor extracted from TableView's selection, on My work, Concepts and Inbox, and j/k through the record peek

- **What:**
  - `useRowKeyboard` is a bare index cursor;
  - TableView's selection (`checkedPaths`, `anchorRow`, Shift-click) is inline;
  - Inbox has its own arrow handler, and My work and ConceptTable have no cursor;
  - only ViewCanvas publishes `detailSiblings`, and My work jumps to a record's database.

  SHELL-5. Home goes to .3b.
- **Files:**
  - new: `src/engine/listCursor{,.test}.ts`, `src/hooks/useListCursor{.ts,.test.tsx}`, `src/app/commands/{list,peek}.commands.ts`, `src/components/ListSelectionBar{,.test}.tsx`, `src/knowledge/ConceptTable.keys.test.tsx`, `e2e/list-keys.spec.ts`;
  - changed: `src/app/recordActions{,.test}.ts` (test new), `src/views/TableView.tsx`, `src/pages/MyWorkPage{,.test}.tsx`, `src/knowledge/ConceptTable.tsx`, `src/pages/InboxPage{,.test}.tsx`, `src/detail/DetailPanel{,.test}.tsx`, `src/stores/uiStore.ts`.
- **Approach:**
  - **listCursor.ts** (pure, inside the engine rail).
    - State `{focus, anchor, selected, base}`, over occurrence keys in display order. `selKey` maps a key to a selection key (TableView: row to path).
    - `step` lands first or last from no focus, clamps and ends a Shift run. Also `edge` and `extend` (base plus the range anchor…focus).
    - `toggle`, `rangeToggle` (TableView's Shift-click) and `toggleAll`.
    - `escape` clears the selection, then the focus, and reports what it consumed.
    - `reconcile` drops gone selections and moves a gone focus to the row now at its index.
  - **useListCursor** `({keys, selKey?, onOpen, focus?, onFocusChange?, selectable?, peek?})`. `keys` may be a function (DOM order, for Home).
    - It binds list.* in its page scope (Appendix A).
    - j/k move roving focus and scroll. The first j from body lands on the first row. ⇧J ⇧K, x and ⌘A work only when selectable; g g and ⇧G jump to the ends.
    - Enter acts only when focus is on a cursor row, the container or body, so a focused button keeps its own Enter (M20.4).
    - The container's onKeyDown keeps ArrowUp/Down/Home/End local, and handles Escape when `!hasLayers()`: the selection first, then the cursor.
    - Peek mode publishes `detailSiblings` and clears only its own. j/k re-open a peek showing the cursor row, and the cursor follows `detailPath` without taking focus.
  - **TableView and the bar.** TableView runs its selection through listCursor; its keyboard stays useRowKeyboard, and TableView.test is unchanged. `copyPageLinks(entries)` moves to recordActions. `ListSelectionBar` (`list-selection`, role status) reads "N selected", Copy links and "Esc clears" (Q10).
  - **Surfaces.**
    - My work: M61.3b's section rows, selectable, in peek mode. Rows open with `useOpenPath('in-place')`, so a record peeks over My work (Q9). The list is a listbox of options.
    - ConceptTable: drawn concept paths (collapsed bands skipped), plus ReviewQueueList's paths while its band is open. Enter runs the row's own click.
    - Inbox: `selectedPath` controls the cursor and `onListKeyDown` goes. Enter opens the capture as a page (Q11). A selection sets `aria-multiselectable`. Escape clears it and keeps the capture.
    - DetailPanel binds peek.next and peek.prev to `stepDetail(±1)`, with `when` a neighbour exists.
- **Comments to delete:**
  - TableView: toggleChecked's Shift comment (moves to `rangeToggle`), copyLinks' clipboard comment (moves to recordActions) and RowGutter's "scalar cursor index" line (rewritten).
  - InboxPage's "Arrow keys walk the queue…" (rewritten).
  - MyWorkPage's docblock gains "opens in place; j/k step the peek".
  - uiStore `detailSiblings`' "only the canvas knows…" becomes "the canvas or list that drew it".
- **Tests:**
  - listCursor: every move; rangeToggle replays TableView's Shift-click cases; toggleAll with a record drawn twice; escape order; reconcile.
  - useListCursor:
    - roving focus and the first j;
    - selection keys only when selectable; ⌘A in an input selects text;
    - g g and ⇧G; Enter rules; Escape vs layers;
    - peek publishing, re-open, follow and unmount; controlled focus.
  - TableView.test unchanged. recordActions, ListSelectionBar.
  - MyWorkPage: j/k cross sections; Enter peeks and the selection kind stays mywork; j steps the peek; x then Copy links.
  - ConceptTable.keys: a collapsed band is skipped; Enter opens the concept; a queue row starts the walk.
  - InboxPage: j/k; Enter opens the page; x; Escape keeps the capture; ⌘E.
  - DetailPanel: j/k step; nothing at the ends; j typed in the body types.
  - e2e list-keys:
    - My work: j, j, Enter peeks the second row's record, and j shows the third;
    - j typed in the peek body types;
    - Escape closes the peek, and a second Escape clears an x-selection;
    - Inbox: j moves `1 of N` to `2 of N`;
    - Concepts: j then Enter opens the first concept's page.
- **Acceptance:**
  - Roadmap: a keyed cursor extracted from TableView's selection, with j/k, Shift-extend, x, ⌘A, gg/G, Enter and Esc, on My work, ConceptTable and Inbox.
  - Roadmap: j/k steps the record peek, and steps it from My work.
  - One selection model, with TableView.test unchanged.
  - One Escape closes one thing.
  - Letters in fields type, and a focused button keeps its Enter.
  - D18: rows open pages. A cursor writes nothing.
- **Packaged check (owner):** click a My work row (WKWebView doesn't focus it), press j, then Enter: the peek opens and j steps it. ⌘A selects rows on My work and text in a field, even with the Edit menu present.
- **Wave** 3 · **Depends** M65.1, .1b; M61.3b; M60.7; M53.20 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(lists): one keyed cursor on My work, Concepts and Inbox, and j/k through the record peek (M65.3)`.

### M65.3b Home: one cursor across the lanes, and e marks an event row Done

- **What:** M64.4b's lanes have `home-row-done` but no keys. M64 deferred `e` to M65. Rows live in separate lane components, so the cursor reads DOM order through `Lane.tsx`, the one row anatomy.
- **Files:** `src/app/commands/home.commands.ts` (new), `src/pages/home/{HomeLanes,Lane}.tsx`, `src/pages/home/HomeLanes.test.tsx`, `src/pages/home/useHomeDone{.ts,.test.tsx}`, `src/pages/home/homeKeys.test.tsx` (new), `e2e/home-keys.spec.ts` (new).
- **Approach:**
  - `home.done` is `e` (Home, page scope, palette false).
  - HomeLanes runs `useListCursor` with keys taken from `[data-cursor-key]` rows in DOM order (`HOME_LANES` order), selectable, and passes the cursor to Lane.tsx through context. Its bar reads "N selected · e marks done", with no Copy links.
  - Lane.tsx spreads `cursor.itemProps(`${lane.id}:${row.subject}`, {open, done})` on every `home-row`. `done` is exactly what `home-row-done` calls: on event lanes only, and not while marks are unreadable.
  - `home.done` targets the selection, else the cursor row. Its `when` is true only if a target has `done`, so `e` on a state row passes (D9). It sends each row's rendered revision.
  - `useHomeDone.doneMany(items)`:
    - one toast, "Marked N done" (plus " · K couldn't be marked");
    - one Undo that unmarks each exact mark and restores what it replaced (M64.3);
    - never throws, and stays off undoStore and ⌘Z (M64 Q27).

    When a hidden row had the cursor, the cursor moves to the row now in its place.
- **Comments to delete:** useHomeDone's one-row-at-a-time doc gains `doneMany`.
- **Tests:**
  - homeKeys:
    - j/k cross lanes in order and skip empty ones;
    - `e` on a run row sends the rendered revision, and the cursor lands on the next row;
    - `e` on a state row passes;
    - x on two runs and a task, then `e`, marks the two runs with one toast;
    - with unreadable marks, nothing happens; Enter opens the row's page.
  - useHomeDone: each mark; one toast; one exact Undo; a partial failure is counted; it never throws.
  - HomeLanes: every preset still renders.
  - e2e home-keys:
    - j enters the first lane;
    - `e` on release-scout's run row shows "Marked done" and hides the row, and Undo restores it;
    - `e` typed in a lane field types.
  - Also run home and state-lab.
- **Acceptance:**
  - Roadmap: on Home, j/k move and `e` marks Done.
  - `e` works only on event rows and covers the revision shown (D9). Undo restores exactly, and ⌘Z stays off Done.
  - Rows revealed by Show all join, in `HOME_LANES` order.
  - Every M64 Home preset passes unchanged.
- **Wave** 4 · **Depends** M65.3; M64.3, .4, .4b · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(home): j/k walk Home's lanes and e marks an event row done (M65.3b)`.

### M65.4 Back history entries keep scroll and search; the last place per vault returns after relaunch

- **What:**
  - navStore's history is in memory and holds places only;
  - Back resets a table's scroll, and TypePage and ListPage clear `search` on every mount;
  - a deleted page stays in history;
  - a vault switch keeps the old vault's history;
  - relaunch always lands on Home.

  SHELL-6. Macro writes `last_path` but never reads it.
- **Files:**
  - new: `src/engine/{navHistory,placeResolves}{,.test}.ts`, `src/app/useEntryState{.ts,.test.tsx}`, `src/app/lastPlace{,.test}.ts`, `src/app/LastPlaceHost{,.test}.tsx`, `e2e/history-state.spec.ts`;
  - changed: `src/stores/navStore{,.test}.ts`, `src/{App,App.test}.tsx`, `src/pages/{TypePage,ListPage}{,.test}.tsx`, `src/views/ViewCanvas.tsx`, `src/views/TableView{,.test}.tsx`;
  - seeds (added on review): `src/test/navSeed.ts` (new) and the twelve tests that seed `history` through `useNavStore.setState`: `src/app/{useOpenPath,Sidebar,StatusBar}.test.tsx`, `src/detail/DetailHeaderActions.test.tsx`, `src/knowledge/KnowledgeStrip.test.tsx`, `src/views/TableCellEmpty.test.tsx`, `src/pages/{Inbox,Diagram,Studio,Collection,Doc,Knowledge}Page.test.tsx`.
- **Approach:**
  - **Pure pieces.**
    - `stepLive(slots, index, dir, isLive, same)` drops dead slots, keeps the cursor on the nearest survivor, collapses adjacent equal survivors and steps once. `moved` is false when nothing live lies that way.
    - `readSelection(unknown)` is structural per kind, with a `never` default (M53.14). `restorablePlace` drops a doc's `thread` and knowledge's `nav.run`.
    - `placeResolves(sel, snapshot)` is an exhaustive switch:
      - home, mywork, changes, pulse and settings always resolve; inbox resolves while it is on;
      - doc and diagram need an entry at the path; knowledge and library need their path, when set;
      - collection, list and type check their catalogs;
      - workspace needs its root mounted, and counts as live while roots load; studio needs `studio/<project>`;
      - agents with `process:<slug>` needs an Agent carrying that slug; constructs always resolve.
  - **navStore.**
    - Slots become `{selection, byAgent, state?}`; any parallel arrays fold into one entry first. Tests seed slots through `navSeed(selection)`, and the twelve files that seed bare selections move onto it.
    - `navSeq` bumps only on push, replace, back, forward and reset.
    - `setEntryState(key, value)` writes the current slot: no step, no leaveSurface.
    - `registerEntryCaptor(key, read)` (the last one wins) runs before each push, replace, back and forward, writing into the slot being left; `undefined` deletes the key. Also `readEntryState`.
    - `setLiveCheck(fn | null)`; back and forward go through `stepLive`.
    - `reset()` leaves one Home slot. A `restore` option is ignored by M59.3's log. A replace starts with empty state, and replacePath keeps it.
  - **View state.**
    - `useEntryState<T>(key, initial)`, and `useEntryScroll(ref, key | null)`, which restores on mount and on `navSeq`, then again next frame, only when a value is stored.
    - Allowed keys: `view.search`, `view.controls` and `canvas.scroll`. Overlays (the peek, a diff, the layout editor, menus, dialogs) never enter entry state.
    - TypePage and ListPage keep search and the filter bar in entry state, and the re-seed effect stops clearing search. They pass `entryScrollKey="canvas.scroll"` to ViewCanvas, which forwards it to TableView only, never to embeds.
  - **Last place.**
    - `lastPlace.ts` keeps `cerebro.lastPlace` (`{[vaultPath]: Selection}`), with read, remember (through `restorablePlace`) and forget in try/catch. `placeSnapshot()` is null unless the vault is ready.
    - `LastPlaceHost` renders nothing and mounts beside AgentActions:
      - a vault switch calls `reset()`;
      - once per open, after the first ready snapshot and only while the boot Home slot is the only slot, it restores with `{replace, restore}`, or silently forgets a dead place;
      - after that restore, it remembers every selection;
      - it sets the live check: everything is live while the snapshot is null.
- **Comments to delete:**
  - TypePage's M16.26 search comment. Rewrite: it never reaches the Type doc, and it rides the Back entry.
  - The re-seed comment narrows to the presentation; ListPage's twins likewise.
  - navStore replacePath's "Back then lands on a path that no longer exists…".
  - leaveSurface's docblock gains "and neither Back nor a relaunch brings it back (M65.4)".
- **Tests:**
  - navHistory: dead slots are dropped and the cursor survives; equal neighbours collapse; Forward mirrors Back.
  - navStore:
    - captors write into the slot being left; setEntryState adds no step;
    - `navSeq` bumps only on slot changes;
    - dead slots are skipped and dropped; reset;
    - a `restore` navigate logs no open (M59.3).
  - useEntryState: per-slot values; scroll restored on remount and on `navSeq`.
  - placeResolves: a `ONE_OF_EACH` table typed over every kind, so a new kind fails typecheck. Each kind resolves, then stops once its target is gone. A JSON round trip; junk is rejected.
  - lastPlace and LastPlaceHost:
    - restore with replace, history length 1;
    - never before ready; skipped when the person moved;
    - a dead place goes Home, is forgotten, and raises no toast;
    - a vault switch resets history and restores the new vault's own place;
    - nothing is remembered before the restore.
  - TypePage:
    - "search and the filter bar come back with Back (M65.4)";
    - "a new tab starts with an empty search";
    - "Back never reopens the record peek".
  - ListPage. TableView: `entryScrollKey`. App.test: clears `cerebro.lastPlace`; lands on a place that resolves, else Home.
  - e2e history-state:
    1. Work item (`sidebar-type`): type `e` into `view-search-input`, scroll `table-view` to 300, open Settings, press ⌘[ off any editor. The input holds `e`, and scrollTop polls to 300.
    2. Open Systems map via ⌘K and reload: the title reads `Systems map — Cerebro`.
    3. With a peek open, reload: `detail-panel` count is 0.
    4. Create A, open X, A and Y, then trash A. ⌘[ goes to X, and ⌘] returns to Y.
    5. Create B, open it, reload: Home shows, with no toast and no `/demo-vault` key stored.
- **Acceptance:**
  - Roadmap: Back returns a table to its scroll position and filter, and relaunch lands on the last place.
  - Overlays never come back.
  - Dead entries are skipped and dropped. A dead last place lands on Home, forgotten, with no toast.
  - A fresh visit and a new tab start with an empty search.
  - Places are kept per vault, and a vault switch starts a fresh history.
  - A restore isn't the person's open.
  - A new Selection kind fails typecheck until readSelection and placeResolves handle it (M66.4b adds `file`).
- **Packaged check (owner):** open a page, ⌘Q, relaunch: it lands on that page. Trash the page and relaunch: Home.
- **Wave** 4 · **Depends** M65.1, .3; M53.14; M55.12; M58.2; M59.1, .3; M60.8; M70.2b · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(shell): Back restores a view's search and scroll, and relaunch lands on the last place (M65.4)`.

### M65.5 One New launcher: a grouped catalog, three recents, a details pane saying where the item lands, and c chords

- **What:**
  - the New menu has three items, and about eight creators are scattered;
  - two database creators disagree: NewTypeDialog writes no starter statuses, while `createDatabase` seeds them.

  PRODUCT-4, SHELL-9. M67.3 and M69 put their rows here.
- **Files:**
  - new: `src/app/createCatalog{,.test}.ts`, `src/app/CreateLauncher{,.test}.tsx`, `src/stores/launcherStore{,.test}.ts`, `src/app/commands/create.commands.test.ts`, `src/library/libraryActions{,.test}.ts`, `e2e/create-launcher.spec.ts`;
  - commands: `src/app/commands/{create,app}.commands.ts` (create rewritten from .1b's stopgap), `src/app/useAppCommands{.ts,.test.tsx}`;
  - doors: `src/app/{CreateMenu,CreateMenu.test,TypeDialogs,RecordComposer}.tsx`, `src/app/typeActions.ts`, `src/app/Sidebar.test.tsx`, `src/library/LibraryPage{,.test}.tsx`, `src/pages/StudioPage.tsx`, `src/detail/DocProperties{,.test}.tsx`;
  - `src/{App,App.test}.tsx`, `e2e/keyboard.spec.ts`.
- **Approach:**
  - **Catalog** (`createCatalog.ts`, React-free).
    - Groups: write, organize, data, diagram (empty until M68), build, ai and capture.
    - Rows `{id, group, label, icon, chord, tagline, lands(ctx)}` (Appendix A2), plus `availableRows` and `groupRows` (non-empty groups only).
    - MRU helpers: `recordUse` (cap 10), `recentRows` (at most 3) and `pruneRecents`.
    - Folders come from `LIBRARY_FOLDER`, `STUDIO_DIR`, `INBOX_DIR` and `TEMPLATES_DIR`, never typed twice.
  - **Store and launcher.**
    - `launcherStore`: `open`, `flow`, `openLauncher`, `closeLauncher`, `endFlow`, and `startCreate(id)`, which records the use for this vault, closes the launcher and sets `flow`.
    - Recents live in `cerebro.launcherRecents`, per vault, in try/catch.
    - `CreateLauncher` mounts beside QuickOpen, so `c n` works with the sidebar collapsed. It is a Dialog (`create-launcher`, "New", 640 wide) holding:
      - a filter combobox through `nameMatches`;
      - Recent (at most 3; rows stay in their groups too);
      - the groups (`role=group`, options with `data-create-id`);
      - the details pane: `create-details`, `create-lands`, the chord keycap and `create-run`.
    - ↑↓, hover, Enter and click work; Escape closes through the Dialog's layer.
  - **Flows call the existing creators** and never throw:

    | Row | Creator |
    | --- | --- |
    | page | NewDocDialog |
    | record | NewRecordDialog (M61.6's composer) |
    | database | NewTypeDialog |
    | database-csv | CsvImportDialog (one batch) |
    | collection | CollectionDialog (Q15) |
    | prototype | NewPrototypeDialog, exported |
    | sub-page | `addSubPage(entry, 'Untitled')`, then openPath |
    | agent, skill, template | `createLibraryItem(kind)`, then `navigate(libraryItemPlace(kind, path))` |
    | capture | the capture command |

    A null answer leaves the app where it was.
  - **Commands.**
    - `create.commands.ts` holds `create.launcher` (`c n`, "New…") and `create.<id>` (`c <chord>`, "New {label}"), each with `when` set to the row being available.
    - .1b's create bindings leave useAppCommands, and capture.new drops `c n` (Q17). keyboard.spec's `c p` case moves to the dialog.
    - ⌘K and Settings list the new commands with no further code.
  - **Doors tidied.**
    - New opens the launcher, with `aria-haspopup="dialog"` and the tooltip "C then N". The three-item popup goes, and its raw Escape listener leaves the rail.
    - NewDocDialog says page. NewRecordDialog and NewDocDialog stay exported.
    - NewTypeDialog creates through `createDatabase` (Q18). A name back closes and navigates; null stays open. "Couldn't create type" and the createItem path go.
    - `createLibraryItem` and `libraryItemPlace` lift unchanged from LibraryPage: the same bytes, agents born paused.
    - The "Types section" lines change (Appendix B).
    - The launcher reads no IPC, so it needs no lab section.
- **Comments to delete:**
  - CreateMenu: the M12.5 "Three things exist…" docblock, the M15 popup, DOM-node ARIA and `circle-check` comments, and NewDocDialog's "a doc is a doc…" (reworded as page).
  - NewTypeDialog's "Declared at birth…".
  - createDatabase's "It deliberately does NOT navigate…": callers decide.
  - DocProperties' UI line.
- **Tests:**
  - createCatalog: unique ids and chords, none `n`; group order; diagram hidden; sub-page needs a page that can grow; capture needs the Inbox; the lands text; the MRU helpers.
  - launcherStore: per vault; a throwing localStorage still opens it; startCreate and endFlow.
  - CreateLauncher:
    - the groups in order, with no Recent before use;
    - keys and hover; the filter narrows Recent and the groups;
    - the details pane follows the active row;
    - each row reaches its creator (mocked); a null answer stays put.
  - create.commands.test:
    - `c p` opens New page and `c n` the launcher;
    - `c s` does nothing without an open page;
    - `c p` typed in an input or contentEditable types.
  - CreateMenu.test: its accessible name stays New.
  - Sidebar.test: New database writes `statuses` and `fields.status`; the plural twin gets `records/recipes-2`; it navigates.
  - libraryActions: the bytes are unchanged. Also LibraryPage, DocProperties, and App.test (mounted at the root, works with the sidebar collapsed).
  - e2e create-launcher:
    1. New shows Write, Organize, Data, Build and AI (plus Capture with the Inbox on) and no Recent. The first row lands "At the top of the vault."
    2. Database "Recipes": its page shows, and `types/recipes.md` holds `statuses:` and `folder: records/recipes`.
    3. Recent lists Database.
    4. `c` `p` off any editor, "Launch notes", Create: the title reads `Launch notes — Cerebro`, and `launch-notes.md` holds `# Launch notes`.
    5. `cp` typed in a page body types.
    6. Settings lists New page as C then P.
- **Acceptance:**
  - Roadmap: one launcher with a grouped catalog of everything creatable, three recents, a details pane saying where the item lands, and c chords. Every row calls the existing creator, and databases go through `createDatabase`.
  - New, `c n` and ⌘K open it.
  - Recent comes from real use only, per vault, newest first.
  - `c <letter>` types inside editors, inputs and modals.
  - Every blank-database door seeds the starter statuses, and CSV keeps one batch.
  - The stale words are gone.
- **Wave** 5 · **Depends** M65.1, .1b, .2, .4; M55.12, .13; M59.3; M61.5, .6; M63.6b; M64.9 · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(shell): one New launcher creates everything through the existing creators (M65.5)`.

### M65.6 cerebro:// links: Info.plist URL type and RunEvent::Opened, buffered until the webview and the vault are ready, delivered once, UI-only

- **What:** no deep links exist. `Info.plist` declares no URL type, the run loop ignores `RunEvent::Opened`, and M53.12's guard refuses non-http schemes. No plugin is needed on macOS. CLIENT-DESKTOP-7.
- **Files:**
  - Rust: `src-tauri/Info.plist`, `src-tauri/src/shell/{deep_link.rs (new), mod.rs}`, `src-tauri/src/lib.rs`, `src-tauri/fixtures/deep-link-payloads.json` (new);
  - adapters: `src/lib/{ipc,ipc.test,mockIpc,mockIpc.test,ipcContract.test}.ts`;
  - app: `src/app/deepLinks{,.test}.ts` (new), `src/app/DeepLinkHost{,.test}.tsx` (new), `src/app/{LastPlaceHost,OpenWithMenu}{,.test}.tsx`, `src/main.tsx`;
  - `e2e/deep-link.spec.ts` (new), `AGENTS.md`, `SECURITY.md`.
- **Approach:**
  - **Scheme.** Info.plist gains `CFBundleURLTypes` (`com.cerebro.app`, scheme `cerebro`); the bundler merges it. No new crate: `tauri::Url` parses.
  - **Parse** (`deep_link.rs`, pure).
    - Scheme `cerebro`, host `open` or `go`, both case-insensitive. The path is empty or `/`; no userinfo or port; at most 4096 bytes.
    - The query is form-decoded. A repeated known key is refused; unknown keys and the fragment are ignored.
    - `open` needs `path`: relative, at most 1024 bytes, with no NUL, control or backslash, and no empty, `.` or `..` segment.
    - `go` needs `to` (`[a-z_]{1,64}`) and allows `database` and `view` (at most 200 chars each).
    - Both take an optional `vault`: 32 hex, lowercased.
    - Anything else is `Refused {reason}` (Appendix B). `latest_link` keeps the last `cerebro:` URL.
  - **Inbox and delivery.**
    - A pure `Inbox`: `receive` holds the link (the latest wins) until taken, and returns it for emitting afterwards; `take()` hands it over once. Wrapped in `DeepLinkInbox(Mutex<Inbox>)`, which recovers a poisoned lock.
    - `resolve` builds `Delivered`, tagged `kind` (open, go or refused), camelCase. `vault` is null or `{id, lookup}`, where lookup is found, unknown or unreadable. It reads runtime.db's registry, so a link names only a vault this Mac has opened (Q19, Q21).
    - Glue: `#[cfg(target_os = "macos")] received` holds before the take and emits `cerebro://deep-link` after it.
    - `take_deep_link`, and `app_link(vault, path)`, which builds the URL through `Url::parse_with_params`, so Rust alone owns the format.
    - lib.rs: `.manage`, the cfg-gated `RunEvent::Opened { urls }` arm, and both commands registered.
  - **Webview.**
    - ipc.ts gains `takeDeepLink`, `listenDeepLinks` and `appLink`, each behind `inTauri()`.
    - The mock takes `__cerebroPendingDeepLink` once, installs `__cerebroDeepLink(payload)`, and gives `appLink` a 32-zero id. It never parses, so there is no TS twin.
    - ipcContract's EVENTS gains the event.
    - `deepLinks.ts`: `readDeepLink`, plus a module queue: `primeDeepLinks()` runs once and awaits the listener before the take; also `shiftDeepLink` and `hasPendingDeepLink(vault)`.
    - main.tsx primes at module scope after `installErrorReporting()` and renders `<DeepLinkHost />` beside `<App />`.
  - **DeepLinkHost** shifts each link before acting, so each is delivered once. It never writes.
    - With no vault open, a link waits.
    - Another found vault shows `deep-link-confirm`. Open opens that vault and delivers after its first ready scan; Stay here drops the link.
    - Unknown and unreadable lookups toast different words. Otherwise the link waits for this vault's ready scan.
    - `open` needs an entry at the exact path. A missing one toasts and creates nothing; a found one goes through `openPath`.
    - `go` goes through `navigateTarget`, and `refused` toasts its reason.
    - LastPlaceHost's restore yields to `hasPendingDeepLink`.
    - OpenWithMenu gains "Copy Cerebro link" (desktop only), which toasts after the write.
  - **Fixture and docs.**
    - `deep-link-payloads.json` (prettier-formatted, no digest, no `/Users` path) holds one `Delivered` per variant and lookup. Rust and TS read it as a shape check. It gets a twin-registry row only if `twins.test.ts` demands one.
    - AGENTS.md: `shell/` names deep_link.rs, and the next free CV (Appendix B). SECURITY.md: links are untrusted input that only navigate inside registered vaults.
- **Comments to delete:**
  - ipc.ts' "listenVaultChanged is the one event here", if M55.10 left it.
  - Info.plist's header comment gains why the URL type is there.
  - shell/mod.rs' module doc names deep_link.rs, as does AGENTS.md's `shell/` entry.
  - main.tsx's module-scope comment gains the prime.
- **Tests:**
  - deep_link.rs:
    - `parses_the_link_table`;
    - `only_the_last_cerebro_url_counts`;
    - `a_link_before_the_take_waits_and_the_latest_wins`;
    - `the_take_hands_over_once`;
    - `after_the_take_links_go_out_at_once`;
    - `a_poisoned_inbox_still_answers`;
    - `an_app_link_parses_back_to_its_page_and_vault`;
    - `a_vault_id_resolves_only_through_the_registry`;
    - `delivered_links_serialize_as_the_shared_payloads`.
  - shell/mod.rs: `info_plist_declares_the_cerebro_scheme`; `opened_urls_reach_the_inbox` (a source scan).
  - deepLinks: the listener binds before the take; a second prime does nothing; the queue keeps order.
  - DeepLinkHost:
    - waits for the first scan; opens once under StrictMode;
    - a missing page creates nothing;
    - another vault asks first;
    - the lookup words differ;
    - `a delivered link writes nothing` (M58.1's `__cerebroMockWrites` stays empty).
  - Also LastPlaceHost, OpenWithMenu, ipc, mockIpc and ipcContract.
  - e2e deep-link (`__cerebroPendingDeepLink` seeded by an init script before `boot`):
    1. With a stored last place of Settings, a link to `cutover-prd.md` shows the PRD. Home stays Home after 500 ms, and ⌘[ returns to the PRD with nothing before it.
    2. A missing path toasts "This link points to…", and no file appears.
    3. Another found vault shows the confirm, and Stay here keeps the demo vault open.
    4. A live `go` to history opens History.
    5. A refused payload toasts its reason.
- **Acceptance:**
  - Roadmap: `open "cerebro://open?…"` opens the page exactly once on a cold start (packaged).
  - A link held before the take is held, latest wins, and taken once; later links arrive as events (cargo).
  - A link waits for the vault's first scan, then opens once, over the last place.
  - Another vault asks first. A missing page creates nothing, a malformed link says why, and nothing writes.
  - Copy Cerebro link parses back to its page and vault.
- **Packaged check (owner):**
  - Quit Cerebro, then run `open "cerebro://open?path=projects%2Fphoenix-warehouse-rollout%2Fcutover-prd.md"`. The PRD shows once, with nothing behind it on Back.
  - While running, `open "cerebro://go?to=history"` shows History.
  - Copy a link in vault A, switch to B and open it: it asks, and Open lands on the page.
  - `open "cerebro://nope"` toasts.
  - If LaunchServices picks another bundle, run `lsregister -f` on the installed app.
- **Wave** 5 · **Depends** M65.4; M53.12, .24; M54.3; M55.9; M58.1; M59.1; M64.5 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(shell): cerebro:// links open a page once, after the vault is ready, and never write (M65.6)`.

### M65.7 save_note gains an expected-version guard for writers outside the editor (Home task ticks, the Library)

- **What:** two human writers read whole bodies, then save them later:
  - useDocTasks' toggle (read, `toggleTaskLine`, save);
  - LibraryPage's editor, which loads once and saves later.

  Either can silently overwrite a newer write, or tick the wrong line once lines move. M64 Q9 waits on this guard. Saves from an open editor stay last-write-wins (D2).
- **Files:**
  - Rust: `src-tauri/src/vault/write.rs`, `src-tauri/src/{lib,mcp}.rs`, `src-tauri/src/{ledger/shadow,runtime/vault_writes}.rs` (test callers, added on review), `src-tauri/fixtures/write-doors.json`;
  - adapters: `src/lib/{ipc,ipc.test,mockIpc,mockIpc.test}.ts`;
  - app: `src/engine/staleContent{,.test}.ts` (new), `src/engine/tasks.ts`, `src/hooks/useDocTasks{.ts,.test.tsx}`, `src/library/LibraryPage{,.test}.tsx`;
  - `shared/policy/README.md`, `AGENTS.md`, `e2e/save-guard.spec.ts` (new).
- **Approach:**
  - **Rust.**
    - write.rs `save_note(…, expect, by)` passes `expect` into `rewrite_note` and returns the hash it wrote. Its test callers (ledger/shadow.rs ×3, runtime/vault_writes.rs ×1) pass `None` and drop the hash. M55.3's check becomes `normalize_expect_hash`, which mcp.rs's `parse_expect_hash` calls, keeping its words.
    - The `save_note` command gains `expect_hash: Option<String>` and answers `Option<String>`.
    - A malformed hash writes nothing. On knowledge/, a hashed save compares the current bytes before M23.7's capture valve (Q23), and a capture answers None.
    - A stale save answers the Appendix B words and records one operational `stale_content` row under surface `save_note`, following M60.6's `batch` precedent. No hash behaves as before.
    - The code already exists, so there is no README ritual.
  - **Mock and doors.**
    - write-doors.json gains two rows: a stale hash is refused in those words and records nothing; the real hash records `vault.write`.
    - `saveNote(vault, path, body, expectHash?)` returns `Promise<string | null>` through `pageWrite`. The mock mirrors Rust's check, compare and words.
    - `staleContent.ts`: `STALE_PREFIX` and `isStaleContent`.
  - **Home ticks.**
    - DocTask gains `version`. useDocTasks reads only `.md` files, through `readNoteSource`, and keeps its cache while `entry.hash` matches.
    - `toggle` re-reads first. A changed hash writes nothing: it toasts, drops the cache entry and rescans.
    - Otherwise it runs `toggleTaskLine`, then `saveNote(…, task.version)`, and a stale answer takes the same path.
    - It never throws and never retries on its own (Q24).
  - **Library.**
    - LibraryEditor loads through `readNoteSource` and keeps `baseHash`; Save sends it with the body.
    - After the title and frontmatter writes, `baseHash` becomes `updateFrontmatter`'s answer. On null, it re-reads.
    - A stale save writes nothing and shows `library-stale`, offering "Load the new version" or "Save mine anyway" (no hash, Q22). The draft stays dirty until one is chosen.
    - M64.9's RecipesOffer is untouched.
  - **Docs.**
    - AGENTS.md: M55.3's CV becomes "Agent writes compare; editor saves win (D2)" (Appendix B). Its enforced line gains `src-tauri/src/vault/write.rs::a_stale_save_from_outside_the_editor_writes_nothing`.
    - The README's `stale_content` paragraph gains the human save door.
    - Grep AGENTS.md, SECURITY.md and README for other "last write wins" lines.
- **Comments to delete:**
  - rewrite_note's "human writers never pass one". Now: the editor's saves never pass one.
  - save_note's docblock gains the expectation.
  - AGENTS.md's "Human saves never compare: the last write wins.", and the README's agent-only wording.
  - useDocTasks' "Fresh read: the cached line index may be stale…".
  - LibraryPage's "Body first, then title, then frontmatter…" and "Loads ONCE per file…".
  - The docs on mockIpc saveNote and lib.rs save_note gain the check.
- **Tests:**
  - write.rs:
    - `a_stale_save_from_outside_the_editor_writes_nothing`: bytes, mtime, `vault_writes` rows and temps unchanged;
    - `a_save_with_the_current_hash_lands_and_answers_the_new_hash`;
    - `an_editor_save_never_compares`;
    - `a_malformed_save_hash_writes_nothing`.
  - lib.rs: `a_stale_save_records_one_operational_row`; `a_hashed_knowledge_save_compares_before_the_capture`; the write-doors replay.
  - mcp.rs: M55.3's tests pass unchanged.
  - mockIpc, ipc, staleContent.
  - useDocTasks:
    - rows carry their version, and a tick sends it;
    - a fresh read with a new hash writes nothing and refreshes;
    - a `.mmd` file is never read.
  - LibraryPage:
    - Save sends the loaded hash, then the hash the last write answered;
    - a stale save keeps the draft dirty;
    - both choices work.
  - e2e save-guard:
    1. Through the mock fs, insert a line above phoenix kickoff's tasks without rescanning, then tick "Confirm scope" on Home's My work lane. A toast shows, the line stays, and there is no `[x] Confirm scope`. A second tick writes `- [x] Confirm scope` with the line intact.
    2. Library → Skills → Weekly review: edit, change the file in the mock fs, then Save. `library-stale` shows, the file keeps the outside text, and Load the new version shows it.
- **Acceptance:**
  - Roadmap: `save_note` gains an expected-version guard for writers outside the editor, so two views of one file can't overwrite each other silently.
  - cargo: a stale hash writes nothing, answers `stale_content` and records one row; a matching hash answers the new hash; no hash behaves as before.
  - A stale Home tick writes nothing, says so and refreshes, and the next tick flips the right line.
  - A stale Library save offers both choices.
  - Editor saves send no hash. The mock speaks in Rust's words, held by write-doors.json.
- **Wave** 6 · **Depends** M65.5, .6; M55.1–.3, .10, .12; M58.1; M60.6, .10; M64.3, .4 · **Size** M · **Crash risk** no (save_note's path, no crash point; Mac cargo keeps the skip list) · **Packaged check** no
- **Commit:** `fix(vault): a save from outside the editor names the hash it read, and a stale one writes nothing (M65.7)`.

### M65.8 Pane model: navStore holds panes with their own history; claims keyed by the edited file path

- **What:** navStore is one canvas with one history. Work's editor groups are the only side-by-side model. Nothing stops a page, the peek and the Inbox from mounting two editors on one file. SHELL-7, the model half.
- **Files:**
  - new: `src/engine/panes{,.test}.ts`, `src/stores/navStoreHook.test.tsx`;
  - engine: `src/engine/{navHistory,destinations}{,.test}.ts`, `src/engine/editorGroups.ts`;
  - editors: `src/editor/openPages{,.test}.ts`, `src/editor/NoteBodyEditor{,.test}.tsx`, `src/mermaid/useDiagramFile.ts`, `src/pages/DiagramPage.test.tsx`, `src/pages/InboxPage{,.test}.tsx`;
  - stores: `src/stores/{uiStore,navStore}{,.test}.ts`;
  - shell and callers: `src/App.tsx`, `src/app/useOpenPath{.ts,.test.tsx}`, `src/agent/AgentActions{,.test}.tsx`, `src/detail/{DetailPanel,DetailHeaderActions}{,.test}.tsx`, `src/views/RecordRowMenu.tsx`, `src/views/ViewCanvas{,.test}.tsx`, `src/hooks/useListCursor{.ts,.test.tsx}`, `src/app/useEntryState.ts`, `AGENTS.md`.
- **Approach:**
  - **panes.ts** (pure; imports types, destinations and navHistory).
    - `MAX_PANES` is 4. A PaneId is `p<seq>`, never recycled. `PaneLayout {panes, active, focusOrder (MRU, active first), seq}`.
    - remapSelection moves here with its docblock, plus `remapPaths`.
    - `CLAIM_RULES` (`satisfies Record<Selection['kind'], …>`) and `claimOf`:
      - doc and diagram claim their path; knowledge and library their path, when set;
      - collection claims its page;
      - inbox and workspace claim `place:<kind>`;
      - other kinds claim nothing;
      - lenses never change a claim.
  - **Moves** (pure).
    - navigatePane: a claim another pane holds focuses the holder and pushes there only when the selection differs. A replace onto a held page drops the forwarding slot.
    - openPane: a held file is reused; under capacity it inserts right of `from`, focused; a full row navigates `from` with outcome full.
    - closePane: the last pane goes Home; the left neighbour, else the right, takes focus.
    - focusPane.
    - stepPane reuses `stepLive` with a skip predicate: held entries are skipped, never dropped.
    - `checkLayout` names every broken invariant.
  - **navStore.**
    - It is built from `zustand/vanilla` `createStore` plus `useStore`, keeping the static API.
    - The focused pane stays inline (selection, history, historyIndex), so readers and every `setState` seed keep working (.4 moved the history seeds onto `navSeed`); other panes are stashed by id.
    - `PaneContext` and `usePaneId()`: inside pane p, `useNavStore` reads p and moves p. Outside a pane, and through `getState()`, it means the focused pane.
    - Actions: navigateIn, back(pane?), forward(pane?), openPane, closePane, focusPane, setPaneCapacity; `openPeek` (focuses a pane that shows the file), `stepPeek` (skips files a pane shows), and replacePath over every pane.
    - leaveSurface works per pane:
      - a diff closes unless another pane shows its page;
      - the peek closes when its own pane leaves, unless keepDetail, and always when the target claims its file.
    - M59.3 records a person's open once, a reuse included. M65.4's captors are keyed by pane, and last place follows the focused pane.
  - **uiStore and editors.**
    - uiStore gains `detailPane` (the peek's owner), `openDetail(path, owner = null)`, `siblingsByPane` with `setDetailSiblings(paths, pane = '*')`, and `stepDetail(delta, skip?)`. A null owner keeps today's rule. The doc panel stays global.
    - openPages.ts: `holdEditor(path, owner)`, `editorHoldersOf` and `subscribeEditorHolders`.
    - NoteBodyEditor holds its path beside registerFlush, under its pane or as `'peek'`, and useDiagramFile holds under `usePaneId()`.
    - Inbox shows "Open in another pane" with Show for a capture another pane holds, never a second editor.
  - **Callers.**
    - App.tsx: the canvas sits inside `PaneContext` valued `active`, and the peek inside one valued `detailPane`.
    - useOpenPath: the pane comes from `usePaneId`, and the call-time selection is that pane's. A held file is focused first and nothing else moves. Records open through `openPeek`, and it returns a NavOutcome.
    - A person's reuse toasts "Already open in another pane." (Q26). The agent's never does, and moves no keyboard focus.
    - DetailHeaderActions and RecordRowMenu use stepPeek and openPeek. ViewCanvas and .3's cursor publish siblings under their pane.
    - destinations.ts: `single: true` on inbox and work, with reasons.
    - AGENTS.md: the next free CV (Appendix B).
    - No Rust, IPC, mock, schema or lab change.
- **Comments to delete:**
  - navStore: leaveSurface's docblock (the peek belongs to its pane, a diff to the pane showing its page); the keepDetail doc; replacePath's "the old path in history" (now every pane's); remapSelection's docblock (moves).
  - uiStore: detailSiblings' and diffView's docblocks.
  - editorGroups' first line (Work's groups; page panes live in panes.ts).
  - AgentActions' "move the user" docblock (now into the pane already showing it, without a word).
  - useOpenPath's "Resolved at CALL time" (this pane's selection).
- **Tests:**
  - panes:
    - claimOf per kind; remap;
    - the moves' edge cases; checkLayout;
    - "invariants hold over random sequences": a seeded PRNG over 20 seeds × 2,000 steps, capacity 1–4, with checkLayout empty after every step.
  - navStore:
    - every existing case passes unchanged;
    - "opening a held file activates its pane";
    - Work and Inbox reuse; Back skips held entries;
    - the peek and diff rules; replacePath across panes; open-log counts;
    - "the peek never shows a file a pane shows", over random sequences.
  - navStoreHook (new): inside p, reads and moves are p's while q is focused; outside a pane, the focused one; selector results stay equal across focus changes.
  - Also uiStore, openPages, NoteBodyEditor, DiagramPage, InboxPage, useOpenPath, AgentActions, DetailPanel, DetailHeaderActions, ViewCanvas, destinations (exactly inbox and work are single), useListCursor and navHistory (the skip predicate).
- **Acceptance:**
  - Roadmap, the model half: opening a held file activates its pane, silently for the agent's `open_note`.
  - With one pane, every vitest and e2e passes unchanged, and nothing on screen changes.
  - vitest proves over random sequences that no file or single place is current in two panes, and that the peek never shows a file a pane shows.
  - Work and Inbox show in one pane at most.
  - Back skips held entries, and M65.4's view state restores per pane.
  - A new Selection kind fails typecheck until claimOf classifies it.
- **Wave** 7 · **Depends** M65.3, .4; M53.6, .14; M55.6, .12; M59.1, .3; M60.10b; M70.2b · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(shell): navStore holds panes with their own history, and a file lives in one pane (M65.8)`.

### M65.9 Pane row: ⌘-click and Shift+Enter open a pane; capacity from the canvas floor; focus, close and Back as registry commands

- **What:** after .8, one pane still shows and nothing opens a second. M52's bands are one-canvas viewport classes, and focus and close have no commands. SHELL-7, the surface half.
- **Files:**
  - new: `src/app/PaneRow{,.test}.tsx`, `src/app/openIntent{,.test}.ts`, `src/app/commands/panes.commands{,.test}.ts`, `e2e/panes.spec.ts`;
  - shell: `src/{App,App.test}.tsx`, `src/app/shellLayout{,.test}.ts`, `src/stores/uiStore.ts`;
  - opens: `src/app/useOpenPath{.ts,.test.tsx}`, `src/app/{Sidebar,QuickOpen}{,.test}.tsx`, `src/hooks/useListCursor{.ts,.test.tsx}`;
  - keys: `src/app/commands/list.commands.ts`, `src/lib/keys/{root.ts, root.test.tsx}`;
  - `AGENTS.md`.
- **Approach:**
  - **Bands** (shellLayout.ts).
    - `paneRowFloor(n)` is 400 for one pane, and n × 400 + 32 beyond.
    - `paneCapacity(row) = clamp(floor((row − 32) / 400), 1, MAX_PANES)`.
    - The park classes are literals: `@max-[832px]/panes:`, `@max-[1232px]/panes:` and `@max-[1632px]/panes:`. Rank 0 never parks.
    - `paneParked` feeds `inert`, and `mainColumnFloorPx` counts the panes.
    - Once the sidebar reaches its floor, panes beyond the focused one park, least recently focused first. They take zero width and stay mounted. M52's media bands stay with the focused pane.
  - **PaneRow.tsx.**
    - PaneRow measures itself, sets the capacity, and is the `@container/panes` root.
    - Each PaneFrame carries `data-testid="pane"`, `data-pane-index`, `data-active` and `data-parked`, inert when parked.
    - Capture-phase pointerdown and focus call focusPane. `@container/canvas` applies only with two or more panes.
    - Each frame is its own page key scope (moved from `<main>`), and root.ts's fallback picks the active one's.
    - PaneBar (two or more panes) shows M59.1's place label and Close (`pane-close`). The focused bar uses `--surface-selected` with cortex ink, never a filled pill.
    - ParkedTabs (`pane-parked-tab`) focus their pane. PaneOutlet is CanvasOutlet's switch.
  - **Open intent.**
    - `installOpenIntent` records a button-0 click with ⌘ or Ctrl in the document capture phase, and `setTimeout(0)` clears it, so no `stopPropagation` can strand it (trap 9: click reaches, pointer events don't).
    - useOpenPath gets `open(path, {newPane?})`. A record opens beside as its page. A full row opens in place with the toast (Q27). The agent never opens a pane.
    - Sidebar destination rows and doors open a pane on ⌘ or Ctrl click.
    - QuickOpen: Shift+Enter, and ⌘ or Ctrl click, open a place row beside; command rows ignore Shift; the footer reads "Open beside" with its keycap.
    - The list cursor binds `list.openBeside` (⇧↵).
  - **Commands.** pane.focusNext ⌥⌘], pane.focusPrev ⌥⌘[ and pane.close ⌥⌘W, all inEditor (Q28):
    - the focus pair needs two or more panes;
    - closing the last pane goes Home;
    - Back and Forward act on the focused pane;
    - ⌘W stays the window menu's, and Escape stays with `layers.ts`;
    - `index.ts` is untouched.
  - **App and docs.** PaneRow replaces CanvasOutlet and .8's provider, and the floors count panes. AGENTS.md: the shell paragraph gains the pane row, and Verifying UI work says to address a pane by `data-pane-index`. No Rust, IPC, mock or lab change.
- **Comments to delete:**
  - shellLayout: the give-way list gains the pane step; TWO_PANEL_ROW and mainColumnFloor speak of the focused pane and every open pane.
  - uiStore CANVAS_MIN_WIDTH's "never yields" becomes: the focused pane never yields.
  - App.tsx's canvas-row comment; CanvasOutlet's comments move unchanged.
- **Tests:**
  - shellLayout: capacity at 400, 831, 832, 1231, 1232 and 2400; each literal equals `paneRowFloor(rank + 1)`; the floors.
  - PaneRow:
    - one pane shows no bar;
    - two frames show one active;
    - pointerdown and focusin focus a frame;
    - Close works, and closing the last goes Home;
    - ranks and parked tabs; the measured capacity.
  - openIntent: ⌘ and Ctrl set it; plain, right and middle clicks don't; a React `stopPropagation` still clears it.
  - useOpenPath, QuickOpen, Sidebar and useListCursor: newPane paths; full falls back; byAgent ignores the intent.
  - panes.commands: cycling; Close; ⌘[ moves only the focused pane.
  - root: the fallback lands on the active pane. App.test.
  - e2e panes:
    1. ⌘-click the Systems map chip: two panes, the second focused.
    2. From the first pane, ⌘K "systems map", Enter: still two panes, the second focused, the toast shown, one Systems map.
    3. ⌘[ in the second pane leaves the first unchanged.
    4. Close leaves one pane; Close pane on the last goes Home.
    5. Shift+Enter in ⌘K opens a second pane.
    6. At 1000×720 a ⌘-click opens in place, with the toast.
    7. At 1280 with two panes, resizing to 1000 parks one (`data-parked`, zero width) and its tab restores it.
    8. Typing after a chip, then closing that pane at once, keeps the text and `[[systems-map]]` on disk (trap 10).

    Seed `delivery/how-we-schedule.md` with `[[systems-map]]` and `[[strategy]]`.
- **Acceptance:**
  - Roadmap: ⌘-clicking a link opens a second pane. Opening the same file from the first pane focuses the second. Closing the last pane goes Home.
  - Shift+Enter in ⌘K and in lists opens a pane.
  - Capacity comes from `CANVAS_MIN_WIDTH`. A full row says so. Narrowing parks the least recently focused pane in one layout pass, and its tab brings it back.
  - One pane draws exactly as before: shell-layout.spec and every other spec pass unchanged.
  - The pane commands show in tooltips, ⌘K and Settings.
  - Closing a pane right after typing keeps the text and its links.
- **Packaged check (owner, Finder build):**
  - ⌘-click a wikilink in a page: a second pane opens, and the first keeps its caret.
  - Narrowing parks a pane with no clipped frame.
  - ⌥⌘[ ⌥⌘] and ⌥⌘W work, and the menu's ⌘W still closes the window.
- **Wave** 8 · **Depends** M65.1, .2, .3, .8; M55.10; M59.1; M64.5 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(shell): ⌘-click and Shift+Enter open a page beside, as many as the window fits (M65.9)`.

### M65.10 Layout saved per vault and pruned on load; one rename hook moves panes, favorites, recents and last place together

- **What:** after .9, panes live in memory only. A rename re-points navStore and M59.3's log. Favorites are pruned instead of moved, and a database rename (M60.11) leaves `{kind:'type'}` places dangling. SHELL-7 persistence, plus 02-shell's missed pointer hygiene.
- **Files:**
  - new: `src/engine/paneLayout{,.test}.ts`, `src/app/{paneLayoutPersistence,pointers}{,.test}.ts`, `e2e/pane-layout.spec.ts`;
  - stores: `src/stores/{navStore,uiStore}{,.test}.ts`, `src/stores/openLogStore.ts`;
  - last place: `src/app/lastPlace{,.test}.ts`, `src/app/LastPlaceHost{,.test}.tsx`;
  - callers: `src/app/{renameActions,typeActions}{,.test}.ts`, `src/App.tsx`;
  - only if the batch's own announce rescans before renameActions regains control (added on review): `src/app/Sidebar{,.test}.tsx`;
  - `AGENTS.md`.
- **Approach:**
  - **paneLayout.ts** (pure).
    - `cerebro.panes` holds `StoredLayout {v: 1, active, panes: {index, entries: Selection[]}[]}`.
    - `isStoredSelection` is `readSelection` plus a `satisfies Record<Selection['kind'], …>` table of the lens fields.
    - `toStored` keeps places only: at most 30 per pane, around the cursor.
    - `readStoredLayouts` reads junk as `{}`.
    - `pruneLayout` drops dead entries and empty panes. A later pane that repeats an earlier claim steps back, or goes. It keeps at most `MAX_PANES` around the active pane, and returns null when nothing is left.
  - **Stores.** navStore gains `restoreLayout` (fresh ids; closes the peek and diff) and `renameType` (view kept), and replacePath stops remapping the open log. lastPlace gains `remapLastPlace` and `renameLastPlaceType`. uiStore gains `remapFavorites`: descendants too, order kept, duplicates merged.
  - **One rename hook** (`pointers.ts`).
    - `followRename(vault, from, to)` moves panes, last place, favorites and recents.
    - `followTypeRename` moves type places and last place.
    - Neither throws; `from === to` does nothing.
    - renameActions calls it per landed step before awaiting the catch-up rescan, with Undo and Redo in reverse order. Sidebar prunes favorites on every entries change, so a remap after the rescan finds the old pin gone. If the batch's own announce rescans first, Sidebar's prune instead waits while a rename is pending.
    - renameDatabase calls followTypeRename once its batch lands.
  - **One restore point** (`PaneLayoutHost`, beside RemindersHost). Once per vault, when ready:
    1. a pending deep link wins (.6);
    2. else the stored layout, pruned with `placeResolves`, is restored;
    3. else last place;
    4. else Home.

    LastPlaceHost keeps the vault-switch reset, the remember subscription and the live check. Layouts are written per vault, only after that vault's restore, in try/catch. A throw keeps the session layout silently, because this is a convenience, never a record.
  - **Docs.** AGENTS.md takes the next free CV (Appendix B). No Rust, IPC, mock, schema or code change.
- **Comments to delete:**
  - navStore replacePath's "Follow a file that moved (M15)…": moves to followRename, and replacePath says only the hook calls it.
  - uiStore favorites' "pruneFavorites drops any that stopped resolving": a rename moves a favorite, and pruning drops a gone one.
  - renameActions' replacePath comments.
  - openLogStore remap's "navStore's rule".
  - LastPlaceHost's restore comment.
- **Tests:**
  - paneLayout: round trip; junk; dead entries; empty panes; repeated claims; Inbox kept once; `MAX_PANES`; 30 per pane.
  - paneLayoutPersistence:
    - a vault's layout is written only after its restore;
    - a switch never writes vault A's panes under B;
    - the restore runs once per open;
    - a stored layout beats last place, which beats Home;
    - storage failures are silent;
    - a pending link skips the restore.
  - pointers: `only the rename hook remaps pointer stores`, a source scan for replacePath, remapFavorites, renameType, remapLastPlace and the log's remap outside their stores and tests.
  - Also navStore, uiStore, lastPlace, LastPlaceHost, renameActions (Undo reversed; a refused batch calls nothing; a rescan that lands the moment it is awaited still finds the favorite moved) and typeActions.
  - e2e pane-layout:
    1. Two panes with the first focused survive a reload.
    2. A peek open at reload doesn't come back.
    3. A stored pane on `notes/gone.md` boots one pane, with no "no longer exists".
    4. Pin Strategy, show it in the second pane and open it once from ⌘K, then rename it in the Pages tree, confirming M60.10's prompt if shown. The pane, the favorite and Recent read the new title. No reload here: the mock fs reseeds at load, so the relaunch half is the packaged check's.
- **Acceptance:**
  - Roadmap: reload restores both panes and which was focused. A stored layout beats last place.
  - Dead entries and empty panes go. Nothing left lands on last place, then Home.
  - Overlays and the Inbox selection never come back.
  - A rename moves the pane, the favorite, the recent and the last place in one call, and Undo moves them back. A database rename moves type places.
  - Layouts are per vault. The rail holds.
  - A new Selection kind fails typecheck until `isStoredSelection` lists its lenses.
- **Packaged check (owner):** a relaunch restores both panes and the focus. A page renamed while open keeps its pane and favorite across a relaunch.
- **Wave** 9 · **Depends** M65.4, .6, .8, .9; M59.3; M60.10, .10b, .11 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(shell): the pane layout survives a reload, and a rename moves every pointer together (M65.10)`.

## Done or dropped

- **Implemented, unstaged:** all 10 roadmap parts and the .1b/.3b splits. Browser and focused checks are recorded above; final broad and packaged gates remain. **Dropped:** none.
- **Split,** each by its own roadmap bullets:
  - .1 → .1b: chords, keycaps and the Settings list, plus the last listeners (⌘S, ⌘F).
  - .3 → .3b: Home's cursor and `e`.
- **Beyond the roadmap, on purpose:**
  - .1 makes ⌘ alone the modifier on macOS (Q1).
  - .1b puts the go letters in M59.1's table and adds a scan for hard-coded keycap glyphs.
  - .2 previews a theme without writing it.
  - .3 opens My work's records in place, and adds the selection bar.
  - .5 sends NewTypeDialog through `createDatabase`, renames New doc to New page, and lifts `createLibraryItem`.
  - .6 adds Copy Cerebro link.
  - .10 moves favorites on a rename instead of pruning them.
- **Not built unless asked or measured:**
  - pane resize, and more than 4 panes;
  - the raw Escape listeners moving to `layers.ts` (Q2);
  - dialog-local keys in the registry (Q6);
  - relaunch restoring scroll and search (Q13);
  - links that name a vault by its store uuid (Q19);
  - menu-event routing for ⌘W, ⌘Z or ⌘A, only if a packaged check shows the menu wins.

## Owner questions

Each default applies if unanswered.

| # | Part | Question | Default taken |
| --- | --- | --- | --- |
| Q1 | .1 | On macOS, should only ⌘ fire app shortcuts, so ⌃K, ⌃E and ⌃F go back to line editing? | Yes; Ctrl stays the modifier elsewhere. |
| Q2 | .1 | Move the raw Escape listeners (InlineDiff, ViewTabs, RecordTabs ×2, CreateMenu) to `useEscapeLayer` now? | No. The rail lists them with reasons, and CreateMenu's goes with .5. |
| Q3 | .1b | g letters: h Home, i Inbox, m My work, s Studio, y History, l Library, w Work, k Knowledge, a Agents, c Changes, comma Settings? | Yes. |
| Q4 | .1b | Ship `c p`, `c d` and `c n` before .5's launcher? | Yes; .5 takes them over. |
| Q5 | .1b | Once the hint shows (200 ms), swallow a key that completes no chord? | Yes; a faster key passes through. |
| Q6 | .1b | Dialog-local keys (the composer's and review notes' ⌘Enter, M61.6, M58.5) stay out of the registry and the list? | Yes. The editor claim covers ⌘Enter, and their hints render through Keycaps. |
| Q7 | .2 | Chips: All, Pages, Databases, Places and Commands, with agents reached through Open agent…? | Yes. |
| Q8 | .2 | With no match, nothing is highlighted and Enter does nothing, with Ask one ↓ away? | Yes, per the roadmap. |
| Q9 | .3 | My work opens a record in the peek over itself instead of jumping to its database? | Yes. |
| Q10 | .3 | x, ⇧J/⇧K and ⌘A on My work, Concepts and Inbox get an "N selected · Copy links" bar? | Yes; the alternative is Home only. |
| Q11 | .3 | On Inbox, Enter opens the capture as a page? | Yes. |
| Q12 | .3b | `e` on a selection marks every selected event row done, with one toast and one Undo? | Yes. |
| Q13 | .4 | Should a relaunch also restore scroll and search? | No; places only. |
| Q14 | .4 | Should a vault switch clear Back history? | Yes. |
| Q15 | .5 | The Collection row calls `createCollection`, which still writes the retired `collection.yml` (M47 D2). Keep it? | Yes, unchanged; retiring it is its own part. |
| Q16 | .5 | Folder and "Page from template" stay out of the launcher? | Yes; the Pages tree keeps them. |
| Q17 | .5 | `c n` opens the launcher, and `c` alone shows the hint? | Yes. |
| Q18 | .5 | The Sidebar's New database dialog takes `createDatabase`'s shape (table icon, no colour, starter statuses)? | Yes (PRODUCT-4). |
| Q19 | .6 | Name a vault by its local registered id, not the ledger store uuid? | Local id; it breaks if the folder moves. |
| Q20 | .6 | A `cerebro://` link clicked inside a page stays refused (CV-16)? | Yes; links come from outside only. |
| Q21 | .6 | Never open a folder Cerebro hasn't opened on this Mac? | Yes; unknown vaults toast. |
| Q22 | .7 | Should the Library's stale bar offer "Save mine anyway"? | Yes. |
| Q23 | .7 | Compare a hashed knowledge/ save before the capture valve, rather than inside the ledger writer? | Before the valve; a one-call window. |
| Q24 | .7 | Should a stale tick ask the person to tick again, rather than retry? | Ask. |
| Q25 | .8 | Which places may show in two panes? | All but Work and Inbox; a file in one pane only. |
| Q26 | .8 | Should a person's open of a page shown in another pane say so? | Yes: "Already open in another pane."; the agent stays silent. |
| Q27 | .9 | ⌘-click when the row is full? | Open in the focused pane, with the toast. |
| Q28 | .9 | Pane keys? | ⌥⌘] and ⌥⌘[ focus, ⌥⌘W closes; ⌘W stays Close Window. |
| Q29 | .9 | As the window narrows, do extra panes park before the panels shrink? | Yes, once the sidebar is at its floor. |
| Q30 | .9 | How many panes, and resizable? | At most 4, equal widths, no resize. |
| Q31 | .10 | What does a saved layout keep? | Places (at most 30 per pane) and the focused pane only. |
| Q32 | .10 | Should a database rename move panes and last place? | Yes, through `followTypeRename`. |

When to ask, by wave:

| Wave | Questions |
| --- | --- |
| 1 | Q1–Q2 |
| 2 | Q3–Q6 |
| 3 | Q7–Q11 |
| 4 | Q12–Q14 |
| 5 | Q15–Q21 |
| 6 | Q22–Q24 |
| 7 | Q25–Q26 |
| 8 | Q27–Q30 |
| 9 | Q31–Q32 |

## Risks

- **Size:** 9 L + 3 M ≈ 10.5 L, about 1.7× the roadmap. Seams if a part outgrows L:
  - .2's choosers as .2b;
  - .5's doors as .5b;
  - .8's uiStore owner as .8b.
- **96 `stopPropagation` sites** (roadmap risk): the capture phase and explicit claims answer them.
  - Capture means the keymap sees keys before every editor, so an unclaimed non-editable editor would double-act.
  - M66's viewers, M67's grid and M68's canvas bind in their own inner scope, with `shadows`, and claim `typing` on a focusable root (Contracts).
  - Two whiteboards on one page now undo only the newest one (eclipse); before, both fired.
- **M52's bands** (roadmap risk): .9 keeps them on the focused pane and parks the rest. One pane must draw exactly as before, which shell-layout.spec guards.
- **Chords** leave M16's Notion premise (D11). A leader is consumed on a non-editable focus, so .1b runs the full e2e suite.
- **Native menus** (M55.10) may take ⌘W, ⌘Z or ⌘A before the webview. This is unmeasured; packaged checks .1, .3 and .9 decide it, with M60.7's fallback.
- **WKWebView** never focuses a clicked button (pointerdown tracking covers it), and drops pointer events in custom blocks (trap 9; click intent covers it). Only packaged checks prove either.
- **Reloads change:** a reload lands on the last place (.4) and a stored layout (.10). The full suite at .4 and the wave tips catches specs that expect Home.
- **Deep links:** only a packaged build proves them.
  - Worktree bundles share `com.cerebro.app`, so LaunchServices may pick another copy.
  - `RunEvent::Opened` exists only on macOS, so its glue is cfg-gated for Linux clippy.
  - Its cold-start order against Ready is unmeasured; the inbox handles either order.
  - ToastHost lives in the vault branch, so a link's toasts wait for a vault.
- **Writes (.7):** knowledge/'s compare runs outside the ledger lock, a one-call window. The Library's title and frontmatter writes after the guarded body don't compare. DocPage's Apply template keeps its unguarded body write.
- **Names from unbuilt plans:** M55–M64 are planned, not built. Every part re-reads finished names and anchors by name. M66–M69 lean on the contracts above.
- **Hot files** (the waves serialize them):

  | File | Parts |
  | --- | --- |
  | App.tsx | .1, .1b, .4, .5, .8, .9, .10 |
  | AGENTS.md | .1, .1b, .6, .7, .8, .9, .10 |
  | InboxPage.tsx | .1, .1b, .3, .8 |
  | useAppCommands.ts | .1, .1b, .2, .5 |
  | uiStore.ts | .3, .8, .9, .10 |
  | Sidebar.tsx | .1, .1b, .9 (.10 only if it gates the prune) |
  | DetailPanel.tsx | .1, .3, .8 |
  | app.commands.ts, e2e/keyboard.spec.ts | .1, .1b, .5 |
  | root.ts, root.test.tsx | .1, .1b, .9 |
  | navStore.ts | .4, .8, .10 |
  | useListCursor.ts | .3, .8, .9 |
  | LastPlaceHost.tsx | .4, .6, .10 |
  | commands/index.ts, keydownRail.test.ts | .1, .1b |
  | QuickOpen.tsx | .2, .9 |
  | TableView.tsx | .3, .4 |
  | navHistory.ts, useEntryState.ts | .4, .8 |
  | lastPlace.ts | .4, .10 |
  | useOpenPath.ts | .8, .9 |
  | destinations.ts | .1b, .8 |
  | NoteBodyEditor.tsx, openPages.ts | .1b, .8 |
  | useDiagramFile.ts | .1, .8 |
  | DiagramPage.test.tsx | .1, .4, .8 |
  | RecordComposer.tsx | .1b, .5 |
  | lib.rs, ipc.ts, mockIpc.ts | .6, .7 |
  | LibraryPage.tsx | .5, .7 |

- **Changes the owner will see:**
  - ⌃K, ⌃E and ⌃F edit text again on macOS (.1);
  - chords with a hint, keycaps in tooltips, and Keyboard shortcuts in Settings (.1b);
  - commands, chips and choosers in ⌘K, and Enter on no match no longer asks (.2);
  - j/k on My work, Concepts, Inbox and the peek; My work peeks in place; a selection bar (.3);
  - `e` on Home (.3b);
  - Back keeps search, the filter bar and scroll; a relaunch returns to the last place (.4);
  - one New launcher; New database seeds statuses; "New page" (.5);
  - `cerebro://` links and Copy Cerebro link (.6);
  - stale ticks and Library saves refuse (.7);
  - nothing from .8;
  - ⌘-click and ⇧↵ open a second pane, with pane keys (.9);
  - panes survive a reload, and favorites follow renames (.10).
- **Left open on purpose:**
  - the raw Escape listeners (Q2), and dialog-local keys (Q6);
  - TableView keeps arrows only (no j/k), and virtualizing it would need an anchor row for scroll;
  - collection.yml writes (Q15);
  - a moved vault folder breaks its links (Q19);
  - no pane resize.

## Gate

- **Each part,** before its commit:
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test:run`;
  - Rust parts (.6, .7) add `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and the skip-listed `cargo test`;
  - `PORT=<free> pnpm e2e <specs>`, once `lsof -iTCP:<port> -sTCP:LISTEN` shows the port free:

    | Part | Specs |
    | --- | --- |
    | .1 | `keyboard` (new), smoke, workspace, diagrams, undo, find-replace, inbox, agent |
    | .1b | the full suite (leaders are letters) |
    | .2 | `palette-commands` (new), quick-open-recent, quick-open-content, destinations |
    | .3 | `list-keys` (new), deadlines, inbox, knowledge, collections, undo |
    | .3b | `home-keys` (new), home, state-lab |
    | .4 | the full suite (reloads land on the last place) |
    | .5 | `create-launcher` (new), keyboard, record-composer, csv-import, collections, studio, agents, starter |
    | .6 | `deep-link` (new), open-with, smoke |
    | .7 | `save-guard` (new), home, recipes, agents |
    | .8 | the full suite |
    | .9 | the full suite (`panes` new) |
    | .10 | `pane-layout` (new), panes, rename-links, database-rename, history-state, quick-open-recent |

- **Each wave tip:** the same gate on the branch, plus `pnpm test:coverage` and the full e2e suite.
- **M65 closes when:**
  - the full gate passes on the tip, with every coverage floor held or raised;
  - CI is green on the push, the Linux crash suite included;
  - every roadmap M65 acceptance bullet holds;
  - the owner has run the packaged checks (.1, .1b, .3, .4, .6, .9, .10) on a `./scripts/mac-build.sh` build and looked at the built app;
  - the roadmap's M65 status records the splits, the re-measures and D11 (b) as default taken, and closes M64's `e` item.

On the Mac, cargo always runs as:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --skip crash --skip killed_ \
  --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

## Appendix A — the command catalog

`mod` is ⌘ on macOS and Ctrl elsewhere. Letters (no mod, ctrl or alt) stand down on editable targets and under modal layers. Settings lists every row with keys, in `GROUPS` order, then file-declared groups.

| Id | Keys | Scope | Group | Flags | Part |
| --- | --- | --- | --- | --- | --- |
| palette.open | `mod+k` | app | General | inEditor, inModal, palette false | .1 |
| assistant.toggle | `mod+j` | app | General | inEditor, inModal | .1 |
| capture.new | `mod+shift+n` (and `c n` from .1b until .5) | app | General | inEditor, inModal | .1 |
| theme.toggle | `mod+shift+l` | app | General | inEditor, inModal; "Switch light and dark" | .1 |
| nav.back, nav.forward | `mod+[`, `mod+]` | app | General | stand down in editors (outdent, indent) | .1 |
| undo, redo | `mod+z`, `mod+shift+z` | app | General | when `!hasLayers()` | .1 |
| diagram.undo, diagram.redo | `mod+z`, `mod+shift+z` | page, peek, block | Pages | shadows undo and redo; palette false; a block binds only while editing | .1 |
| work.split | `mod+\` | page | Work | — | .1 |
| work.prevTab, work.nextTab | `mod+shift+[`, `mod+shift+]` | page | Work | — | .1 |
| work.closeTab | `mod+w` | page | Work | desktopOnly | .1 |
| work.focusGroup | `mod+1` … `mod+9` | page | Work | desktopOnly | .1 |
| inbox.file | `mod+e` | page | Inbox | when a capture is open; "File the open capture" | .1 |
| go.<id> | `g <letter>` | app | Go to | palette false; go.inbox only while the Inbox is on | .1b |
| create.page, create.database | `c p`, `c d` | app | Create | stopgap; .5 rewrites the file | .1b |
| page.save | `mod+s` | app | Pages | inEditor; when a page is open | .1b |
| find.open, find.replace | `mod+f`, `mod+alt+f` | app | Pages | inEditor; replace on editable pages only | .1b |
| find.next, find.prev | `mod+g`, `mod+shift+g` | app | Pages | inEditor; while the bar is open | .1b |
| shortcuts.show | — | app | General | "Keyboard shortcuts" | .2 |
| list.down, list.up | `j`, `k` | page | Lists | palette false (all list rows) | .3 |
| list.extendDown, list.extendUp | `shift+j`, `shift+k` | page | Lists | selectable lists | .3 |
| list.first, list.last | `g g`, `shift+g` | page | Lists | — | .3 |
| list.toggle, list.toggleAll | `x`, `mod+a` | page | Lists | selectable; `mod+a` stands down in editors | .3 |
| list.open | `enter` | page | Lists | focus on a row, the list or body | .3 |
| list.openBeside | `shift+enter` | page | Lists | — | .9 |
| peek.next, peek.prev | `j`, `k` | peek | Record peek | palette false; when a neighbour exists | .3 |
| home.done | `e` | page | Home | palette false; when a target has Done | .3b |
| create.launcher | `c n` | app | Create | "New…" | .5 |
| create.<row> | `c <chord>` | app | Create | when the row is available; "New {label}" | .5 |
| pane.focusNext, pane.focusPrev | `mod+alt+]`, `mod+alt+[` | app | Panes | inEditor; two or more panes | .9 |
| pane.close | `mod+alt+w` | app | Panes | inEditor; the last pane goes Home | .9 |

**Go letters** (.1b, `destinations.ts`): inbox `i` · home `h` · my_work `m` · studio `s` · history `y` · library `l` · work `w` · knowledge `k` · agents `a` · changes `c` · settings `,`.

**A2. Launcher rows** (.5), in catalog order:

| Id | Group | Chord | Lands |
| --- | --- | --- | --- |
| page | Write | p | "At the top of the vault." |
| sub-page | Write | s | "Inside “{page}”, beside its other sub-pages." (only while an open page passes `canHaveSubPages`) |
| template | Write | t | "In templates/, opened in the Library." |
| collection | Organize | l | "A new collection folder at the top of the vault." |
| record | Data | r | "In the database you pick, in its home folder." |
| database | Data | d | "Its page in types/, its records in a folder of their own." |
| database-csv | Data | v | "A new database from a CSV file, one page per row." |
| prototype | Build | b | "A folder under studio/ with an index page." |
| agent | AI | a | "In records/agents/, born paused." |
| skill | AI | k | "In records/skills/." |
| capture | Capture | i | "In inbox/, opened in the Inbox." (only while the Inbox is on) |

## Appendix B — words the owner reads

Review these before each part lands.

**New conventions** (the next free CV ids, in wave order):

- **.1:** "**App shortcuts go through the keymap** (M65.1). A shortcut is a row in `src/app/commands/*.commands.ts`, bound with `useCommand` and dispatched by the one capture-phase listener in `src/lib/keys/root.ts`; Settings → Keyboard shortcuts renders the catalog. Every other keydown listener is listed with its reason. Escape belongs to `layers.ts`, and letters stand down in editors, claimed elements and modal layers." `enforced: src/lib/keys/keydownRail.test.ts::every keydown listener outside the keymap is listed with a reason`, `src/app/commands/index.test.ts::no command binds Escape`
- **.6:** "**A `cerebro://` link only navigates** (M65.6). It arrives as `RunEvent::Opened`, waits in `shell/deep_link.rs` until the webview takes it once, names a vault only by its registered id, asks before switching vaults, and never writes or runs anything." `enforced: src-tauri/src/shell/deep_link.rs::the_take_hands_over_once`, `src/app/DeepLinkHost.test.tsx::a delivered link writes nothing`
- **.7** (amends M55.3's): "**Agent writes compare; editor saves win** (D2). Agent writes, batch ops and undo may name `expect_hash`, and a mismatch refuses as `stale_content`. A person's save from an open editor never compares. A person's write from outside the editor (a Home task tick, a Library save) sends the hash it read and is refused rather than overwriting."
- **.8:** "**One live editor per file** (M65.8). A file shows in one pane at most, or in the record peek. `claimOf` in `src/engine/panes.ts` keys every Selection kind by its edited file path, and Work and Inbox are single. Opening a held file focuses its holder, silently for the agent, and Back skips entries another pane holds. Inside a pane `useNavStore` reads and moves that pane; `useNavStore.getState()` is the focused pane." `enforced: src/engine/panes.test.ts::invariants hold over random sequences`, `src/stores/navStore.test.ts::opening a held file activates its pane`
- **.10:** "**Pointers follow a rename together** (M65.10). Panes and their history, favorites, recents and last place change on a rename only through `followRename` and `followTypeRename` in `src/app/pointers.ts`; a new pointer store joins them. The pane layout is per vault in `cerebro.panes`, pruned on load, and restores places only." `enforced: src/app/pointers.test.ts::only the rename hook remaps pointer stores`

**.1b, keys and Settings:**

- Section heading: "Keyboard shortcuts". Sentence: "Every shortcut Cerebro answers to. Letters never fire while you type, and Escape always closes the innermost panel."
- Tag: "Desktop app".
- Chord hint headings: "Go to", "Create". Row: "Top of list".
- Keycap words off macOS: Ctrl, Shift, Alt, Enter. Alternatives are joined by "or". A chord reads "G then H".

**.2, the palette:**

- Chips: All, Pages, Databases, Places, Commands.
- Choosers: "Change theme…", "Open favorite…", "Open agent…". Headers: "‹ Change theme", "‹ Open favorite", "‹ Open agent". Back button: "Back".
- Theme rows: Light, Dark, System.
- Empty lines: "No favorites yet — star a page to pin it." · "No agents in this vault."
- Kind label: "Command". The footer note adds "tab categories".

**.3 and .3b, lists:**

- Lists: "N selected" · "Copy links" · "Esc clears".
- Home: "N selected · e marks done".
- Toasts: "Marked done" (one row), "Marked N done", plus " · K couldn't be marked". Action: "Undo".

**.5, the launcher:**

- Dialog title "New". Filter placeholder: "Find something to create".
- Groups: Write, Organize, Data, Diagram, Build, AI, Capture; plus "Recent".
- Run button: "Create {label}". Tooltip: "C then N".
- NewDocDialog: title "New page", button "Create page", placeholder "Page title".
- DocProperties (and RecordComposer, if M61.6 kept the line): "No databases yet — make one with New, or from the Databases section."

**.6, links:**

- Confirm (`deep-link-confirm`): title "Open another vault?", body "This link opens a page in “{vault}”.", buttons "Open" and "Stay here".
- Toasts:
  - "This link points to {path}, which isn't in this vault."
  - "This link names a vault Cerebro hasn't opened on this Mac."
  - "Cerebro couldn't read its list of vaults, so this link wasn't opened."
  - "This link couldn't be opened: {reason}."
  - A `go` refusal uses `navigateTarget`'s words.
- Rust reasons: "it isn't a cerebro link" · "cerebro links open or go, nothing else" · "it is longer than 4096 bytes" · "it names {key} twice" · "it names no page" · "its page path leaves the vault" · "it names no place" · "its vault id is malformed".
- Menu: "Copy Cerebro link", toast "Link copied", disabled hint "Desktop app only".

**.7, writes:**

- Rust: "stale_content: {path} changed since it was read, so nothing was saved." · "expectHash must be a 64-character hex hash".
- Home toast: "“{title}” changed since this list was read, so the tick wasn't saved. The list is refreshed — tick it again."
- Library bar: "“{name}” changed on disk since you opened it, so nothing was saved." Buttons: "Load the new version" · "Save mine anyway".

**.8 and .9, panes:**

- "Already open in another pane." Inbox placeholder: "Open in another pane", button "Show".
- "No room for another pane — opened here."
- Close: "Close pane". Commands: "Focus next pane", "Focus previous pane", "Close pane".
- QuickOpen footer: "Open beside", after its `shift+enter` keycap.
