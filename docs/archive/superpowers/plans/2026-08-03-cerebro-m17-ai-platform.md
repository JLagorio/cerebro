# M17 — The AI platform: threads that stay put, agents you can build, AI in the page

**Branch:** `m17-ai-platform` (off `m16-notion-parity`) · **Date:** 2026-08-03
**Trigger:** the user's brief — "everything opens new chat panels; if I start 1
task and then go somewhere else it sends that same command to the assistant in
the window, which is a bad UX and confuses the AI." Plus: a template/skills/
connector library, custom agents built in the UI and scoped to collections/
lists/types, `/` commands and `@` mentions in chat, AI embedded in the doc
editor, and better context/memory prioritisation.

**Research behind this plan:** 8 codebase mappers + 4 web researchers + one
verification critic that spot-checked 16 load-bearing claims against source
(12/13 agents returned; the Rust-spawn mapper died mid-response and its ground
was re-covered by the runtime mapper). Plus a live logged-in walkthrough of
ClickUp (built a Super Agent, read the schema off the real builder) and Notion
(AI panel, `@` menu, in-editor `/` menu, selection toolbar).

---

## The four decisions

1. **Real parallel runs.** `AgentState` becomes a keyed map; concurrency is a
   backend capability, not a frontend illusion.
2. **A skill stays a record.** `type: Skill` remains the authored surface.
   Borrow SKILL.md's progressive disclosure; explicitly *neutralise* the
   ambient `.claude/` inheritance rather than adopt it.
3. **Editor AI lands in-buffer with per-hunk accept/reject.**
4. **Transcripts stay out of the vault.** Runs write a compact, distiller-
   excluded run-log entry instead.

---

## What is actually true today (verified, not assumed)

Every claim below was read at the cited line. Two mappers reported wrong file
*sizes*; their line citations held, and only verified facts made it here.

| | Reality | Evidence |
|---|---|---|
| Agent processes | **Exactly one, app-wide.** Spawning a second silently kills the first. | `agent.rs:110-124` — `child: Mutex<Option<(Child, u64)>>`; `set()` calls `previous.kill()` |
| Stop | **Global.** `stopAgent()` takes no run id. | `agentIpc.ts:98-107`, `agent.rs:129-140` |
| Event stream | **One global listener**, fanned to a module Set. Chat and job runner both self-filter. | `agentIpc.ts:112-135` |
| Conversation ↔ place | **No binding exists.** `Conversation` has no path/surface field; `activeId` is one localStorage key. | `types.ts:56-66`, `conversations.ts:16` |
| Context | Recomputed from `selection` + `detailPath` **every render** and re-sent with every turn — including resumed ones. | `AiPanel.tsx:262-292`, `agent.rs:377-388` |
| Tool policy | **One static list.** `shell` is the only per-run variable. | `agent.rs:330-349` |
| MCP run tokens | Window of **4**. A 5th concurrent run starts getting `-32001`. | `mcp.rs:62` |
| Watcher | Real (`notify` 6), 350 ms debounce, 4 s own-write suppression — but emits a **payload-free** `()`. | `watcher.rs:164` |
| Editor | **BlockNote 0.46.2**, real block model, `/` `@` `[[` menus already built. | `package.json:22-25`, `MarkdownEditor.tsx:182` |
| Search | `haystack.contains(needle)`, unranked, `break` at limit. | `mcp.rs:520-546` |
| Templates | `{{title}}` / `{{date}}` string substitution, docs only. **No record templates exist.** | `lib/templates.ts`, `CreateMenu.tsx:150` |

### The bug, as a chain

The reported symptom is not caused by navigating. **The agent does it to
itself, by obeying its own system prompt.**

```
system prompt: "Call open_note so the user sees what you are referring to."   AiPanel.tsx:520
  → open_note emits a UI action                                              mcp.rs:433, 922-925
  → AgentActions routes it to openPath                                       AgentActions.tsx:29-31
  → any typed record goes to openDetail                                      useOpenPath.ts:56,70
  → openDetail sets aiPanelOpen: false                                       uiStore.ts:483-486
  → the right slot is an either/or ternary, so AiPanel UNMOUNTS              App.tsx:326
  → unmount cleanup calls killRun()                                          useAgentChat.ts:365-380
```

The reply truncates, the panel vanishes, the draft dies. **The same chain fires
when the user clicks a `[[wikilink]]` in an answer** (`AiPanel.tsx:364-367`), a
tool row's path (`:467`), or View diff (`:359-362`).

The M15 "one slot" rule (`uiStore.ts:34-39`) is the root design error. It was
written for a detail panel and caught the assistant in it.

**Four more, confirmed:**

- **Every "Ask the agent" button discards the record it is asking about.**
  `setAiPanelOpen(true)` nulls `detailPath` (`uiStore.ts:656-662`), and the
  snapshot's `activeNote` is derived from `detailPath`. Only the path baked
  into the prompt string survives. 6 invocations across 5 modules.
- **Opening any conversation kills a running background job.** `restore()`
  calls `killRun()` unconditionally (`useAgentChat.ts:409-411`) and hydration
  calls `restore()` (`useConversations.ts:57-64`). The job's ledger row was
  already written, so the note is not retried until it changes.
- **The agent can self-certify `verified`.** `tool_update_frontmatter`
  (`mcp.rs:665-679`) guards Type docs only — `is_knowledge_path` appears at
  469, 492, 578, 699 and *not* there. `write_concept` is therefore not the
  only writer into `knowledge/`. `delete_note` has no `guard_human_write`
  either (`lib.rs:161-164`).
- **An agent write to a file open in the editor is silently overwritten.**
  `NoteBodyEditor`'s load effect deps are `[path, vaultPath, toast,
  emitSaveState]` — **no mtime** (`NoteBodyEditor.tsx:57-80`). Watcher
  suppresses own-writes 4 s, `mcp::vault_changed` is dead code
  (`mcp.rs:448-449` — zero call sites), and the next keystroke's 500 ms
  debounce saves the stale buffer over the agent's work.

*Plausible, unverified:* an orphaned-`Done` race in which a replacement-killed
child's terminal event ends the chat's turn (every link verifies individually;
the interleaving was not reproduced). Multi-run makes it moot.

---

## What the research says

### ClickUp — the five-axis agent, read off the live builder

| Axis | The question it asks |
|---|---|
| **Instructions** | "What should the Agent do when it runs?" — *"Type / to specify tools or @ to mention items"* |
| **Triggers** | Manual (Mention / DM / Assign) · Scheduled · **Automated** (event + criteria) |
| **Skills** | "What actions can the Agent take?" — tool/toolset picker |
| **Knowledge** | "What can this Agent access?" — scoped locations + external search |
| **Memory** | **Recent** / **Preferences** / **Intelligence**, each toggleable, all inspectable |

Agents ship **Deactivated** with an explicit **Activate** button — the rule
M13.4 already wrote ("activation is your act").

Three mechanics worth stealing outright:

- **The two-layer condition model.** Deterministic predicates are evaluated
  *before* the model runs; at most one AI condition follows. For an app that
  pays a subprocess spawn per evaluation, this is the difference between a
  feature and a fan heater.
- **Scope is structural, not a filter.** An Autopilot Agent is *created inside*
  a location and cannot be moved. The trigger only observes events in its
  container; enforcement is inherent rather than prompted.
- **The action slot collapses to one verb.** Five named actions, then the docs
  say "Set the Action to *Do anything with AI*." Capability is expressed by the
  **tool allowlist**, not by an action taxonomy. Do not build the taxonomy.

Strongest negative result: **ClickUp deprecated its prebuilt agent catalogue in
Dec 2025** in favour of seed prompts. Do not ship fixed recipes.

### Notion — context is a visible object, and skills reach into the page

- The AI composer pins the page as a **removable chip**, plus an explicit
  **"Give context"** button. Context belongs to the *thread*, not to wherever
  you are standing. This is the direct answer to "confuses the AI".
- `@` groups **"Current page"** first, then "Link to page".
- The selection toolbar's AI actions are labelled **"Skills"** — the same word
  as the library. Skills are invocable **on a selection**, not just in chat.
- Selecting text **auto-attaches it to the chat as a second chip**. One context
  model serves both surfaces.
- Three distinct in-editor primitives: **Ask AI** (⌘J, transient), **AI Block**
  (persistent, in-document), **AI Meeting Notes**.

### Per-hunk review — the most-validated pattern in the corpus

Cursor and Windsurf **both** replaced per-change accept/reject with
session-level review and **both** got the same backlash. Zed has an open issue
(#12900) asking for the granularity it lacks; the complaint is precise: *"most
suggested edits were correct, but one was problematic, yet they couldn't
approve the good changes without accepting the flawed one."* Two independent
vendors making the same removal and taking the same damage is a signal.

Zed also ships the thread model M17 is heading for: concurrent threads with
independent context, a thread switcher, and worktree isolation for threads that
would edit the same files.

---

## The thesis

M13 found the unlock: **a job = (prompt, tool policy, trigger)**, and skills,
schedules, connectors and agents are that one primitive wearing different
clothes. That still holds. M17 does not add a second model — it removes the two
things that keep the primitive from being usable:

1. **The backend can hold one child**, so every concurrency guard in the
   frontend (`deadRuns`, `turnInFlight`, `learningPath`, `streamReleased`, the
   5-second preempt handoff) is an artifact of that one slot rather than
   protection against anything. Give the backend a map and they all retire.
2. **A run has no place and no declared context**, so context is guessed from
   wherever the user is standing at render time. Bind it, freeze it, show it.

Everything else in this milestone is a surface over those two.

---

## Phase 0 — Foundations

Nothing else is safe until these land. Two fix live bugs on their own.

### M17.1 — Close the trust holes

`update_frontmatter` gets the knowledge guard it never had; `delete_note` gets
`guard_human_write`; the mock backend mirrors both, and the parity test covers
them. Separately, pass `--setting-sources` so a vault's `.claude/` cannot
inject instructions into every turn invisibly — today `agent.rs:490` sets
`.current_dir(vault)` and no such flag exists, so a vault with `.claude/skills/`
or `.claude/CLAUDE.md` is already an unaudited trust boundary. `demo-vault/`
has none, so this is latent rather than active — fix it before it is not.

*Small, urgent, independent of everything below.*

### M17.2 — Break the one-slot rule

The assistant coexists with the record panel. This alone stops `open_note` from
killing the agent's own answer. `DocPage.tsx:603` already ships a second
right-hand column inside `<main>`, so the precedent exists. `App.test.tsx:112-133`
and `uiStore.test.ts:24-47` assert the old rule and change with it; the ~20px-
canvas rationale (`uiStore.ts:34-39`) is answered by a min-width floor and a
collapse, not by mutual exclusion.

### M17.3 — The multi-run backend

`Mutex<Option<(Child,u64)>>` → `Mutex<HashMap<u64, Child>>`; the replacement-
kill in `set()` is deleted; `stop_agent(run)` takes an id (`stop_all` for
shutdown); `onAgentEvent(run, listener)` filters per run; `RUN_TOKEN_WINDOW`
(`mcp.rs:62`) rises above 4 and is justified in a comment; the MCP server's
mutable vault pointer (`mcp.rs:100-108`) becomes a per-run binding; the mock
holds a Map instead of three module singletons (`agentIpc.ts:58-60`).

`deadRuns`, the preempt handoff and `streamReleased` retire here — they exist
only to arbitrate one slot.

**Concurrency cap and cost:** a write turn triggers a full rescan *and* a git
checkpoint (`useAgentChat.ts:229`). N concurrent write turns = N of each. The
cap is a real number to be chosen and stated, not "unlimited". Also fold
`cache_source` into `isWriteTool` (`useAgentChat.ts:428-430`), and add the test
that ties the **three independent hardcoded copies** of the tool-name list
together: `tool_catalog` (`mcp.rs:269`), `tool_policy` (`agent.rs:330`), and
that regex.

### M17.4 — Editor and disk stop fighting

`NoteBodyEditor` learns mtime: an external change to the open file reloads a
clean buffer, or offers reconciliation when the buffer is dirty.
`mcp::vault_changed` (dead since it was written) is either wired up or deleted,
and the watcher's `WatchSignal::Paths` payload — currently thrown away at
`watcher.rs:164` — is carried through, because M17.12 needs it anyway.

---

## Phase 1 — Threads that stay put

### M17.5 — A conversation has a place

`Conversation` gains `place`. `loadConversations` already tolerates malformed
records (`conversations.ts:100-111`), so migration is a default.

This needs a canonical `selectionKey()`, which **does not exist today** — only
ad-hoc scope strings (`ListPage.tsx:124`, `TypePage.tsx:65`), and `navStore.ts:73-77`
explicitly rejects `JSON.stringify` because key order changes the answer.
Decide and write down: is a List+view one place or two? Is `knowledge.nav` part
of the key? A view tab minting its own thread is a defensible answer; an
accidental one is not.

**Decided (`engine/place.ts`, and the module doc is the record).**

*A place is a **subject**, not a lens.* A List is one place whichever view tab
is open; a type screen is one place whichever saved view is open; Knowledge's
all/review/log tabs collapse to one place, while a section or an entity dossier
does not — a dossier IS a subject. `placeOf` returns a `Selection` with the
lens fields stripped, so a place round-trips back to something navigable and
nothing has to be parsed out of a key.

*The open record is deliberately NOT part of the place.* The agent opens
records constantly — `open_note` is how it shows you what it means. If the open
record moved the place, the assistant's own answer would re-anchor the thread
it was answering in: M17.2's bug one layer up. The open record is **context**
(M17.6's chip) — visible and removable. A place is where you stand, and only
the user moves that.

**Also decided: navigation does not switch threads.** The tempting version —
walk into a place, get that place's thread — loses the answer you are reading
the moment you click a `[[wikilink]]` in it, because that click is a
navigation. Notion does not do this either: its chat is global with a visible
context chip, which is M17.6. So a thread is stamped at its **first turn**
(never at creation — an empty thread is not about anywhere), the switcher
**groups** by place with "here" on top, and a thread anchored elsewhere says so
above the composer with a one-click "New one here". Said, never acted on.

Persistence: `MAX_KEPT = 30` with a whole-array localStorage rewrite per save
(`conversations.ts:18`) does not survive place-multiplied thread counts.
Deferred, and it is now a smaller problem than the plan assumed: threads are
not auto-minted per place, so the count still tracks conversations a person
actually had.

### M17.6 — Context is an object, not a guess

Notion's model. The composer shows **chips**: the record, the view, a
selection — visible, removable, and addable via an explicit control. On send,
the snapshot is **frozen into the turn** rather than recomputed per render, so
a resumed session's context matches the thread's place instead of the user's
feet. The six "Ask the agent" call sites stop discarding their subject and
attach it as a chip instead.

`@` in the composer completes against records, views **and agents**, grouped
with the current place first.

### M17.7 — A run registry, and a task list

`agentBusy` (one unowned boolean written from eight places across two hooks)
and `learningPath` become `Record<runId, { owner, place, label, status }>`.
`StatusBar.tsx:225` and `SettingsPage.tsx:240` become a list rather than a flag
— which *is* the "I started a task and walked away" surface: running work is
visible, attributable to a place, and clickable back to its thread.

---

## Phase 2 — The library

### M17.8 — Skills grow up

Progressive disclosure on the catalogue: `skillIndex` (`skills.ts:189`) ships
every skill's name and description in every system prompt today. Three-tier
loading (metadata at rest ≈30-50 tokens/skill, body on invocation, bundled
files on demand) is the mechanism to copy, not the file format.

Skill identity is currently unresolvable across renames — the handle is a
slugified title (`skills.ts:49`) while the run ledger is keyed by path
(`uiStore.ts:221-228`), so a rename mints a new `/handle`, one duplicate
catch-up run, and reshuffled `-2` suffixes on *unrelated* skills. A stable
`slug:` decides it.

Skills gain arguments and an `allowed-tools` declaration.

### M17.9 — The Skills screen

Grid/list, search, enable/disable, "created by me". ClickUp's **Skills Miner**
("scan your tasks, docs and chats to surface workflows worth saving") is the
one prebuilt worth stealing, because it produces *your* skills rather than
shipping a catalogue — and ClickUp's own deprecation of its catalogue is the
argument against shipping one.

### M17.10 — Templates that know things

Record templates do not exist at all (`CreateMenu.tsx:150`); doc templates are
`{{title}}`/`{{date}}` substitution. A template gains an optional instruction
body: "a PRD, filled from the record it was created under and the concepts
anchored to it." The template is still an ordinary markdown file — the AI part
is a declared prompt, not a new artifact type.

---

## Phase 3 — Agents you build in the UI

### M17.11 — The builder

One screen, five sections, mirroring the axes that ClickUp converged on:
**Instructions · Triggers · Tools · Knowledge · Memory**. Ships deactivated
with an explicit Activate.

It edits an **Agent record** — the `type: Agent` that already exists
(`agents.ts`, with `schedule`/`memory`/`tools`/`actor`, already derived and
rate-limited at `jobs.ts:168-187`). One registration mechanism, not two. The
conversational `create-an-agent` skill stays as the other door into the same
file; ClickUp offers exactly the same pair.

Note for the record: `Skill` and `Agent` are the codebase's two live
exceptions to "no type special-casing" (`skills.ts:22`, `agents.ts`). M17 does
not add a third — it reuses `Agent`.

### M17.12 — Triggers

Today's grammar is time-only (`skills.ts:112-116`). It gains events, evaluated
with **ClickUp's two-layer model**: a deterministic gate on frontmatter the
Rust scanner can already answer (status changed, field set, date passed,
created here, moved here), and only then an optional model gate. The watcher
payload from M17.4 supplies the event.

Two honesty constraints stay: unattended runs are **additive-only** (M13.2),
and a schedule means *"runs next time you open Cerebro if due"* — a desktop app
cannot promise otherwise, and edits made while closed produce no event at all.

### M17.13 — Scope that is enforced, not requested

`tool_policy` (`agent.rs:330-349`) is one static list with `shell` as the only
variable. A UI-declared allowlist has to reach the CLI, which is a Rust
signature change — and the vault-authored declaration is capped by the Settings
ceiling, never trusted to raise it. Scope is structural: an agent bound to a
List cannot write outside it, and the refusal is in Rust, not in a prompt.
Prompted scope is what ClickUp does and what its users complain about.

Two known landmines to resolve or explicitly accept: a Collection's entry set
is deliberately empty (`surface.ts:206-210`), so "watch the Product collection"
is undefined until the union over its Lists is specified; and renaming a Type
today rewrites the Type doc and every record's `type:` but **not**
`ListSource.type`, `FieldDef.target` or `from.type` (`TypeDialogs.tsx:132-152`),
so it already empties Lists sourced on it. A type-scoped agent inherits that.

### M17.14 — Memory tiers

The flat `memory:` string becomes ClickUp's three, each toggleable and all
inspectable: **Recent** (working memory of the last runs), **Preferences**
(what the human corrected — durable, high-priority), **Intelligence** (what the
agent inferred — the distiller's existing job, attributed and reviewable).

Check first, before designing: Claude Code has **its own** auto-memory at
`~/.claude/projects/<project>/memory/`, on by default, and Cerebro spawns that
CLI with cwd = the vault. Cerebro's runs may already be accumulating memory
outside the vault, ungoverned by the OKF guards and competing with this design.

### M17.15 — The run log

There is nothing to extend: no table, no file, no event. Every researcher
called it non-negotiable. Per the transcript decision, this is **not** a
transcript — it is `{ agent, trigger, scope, files touched, status }`, written
where the distiller will not read it, so provenance exists without feeding the
corpus its own prose.

---

## Phase 4 — AI in the page

### M17.16 — Ask AI on a selection, with per-hunk accept

Select → ⌘K → prompt → the block is replaced in-buffer with old and new shown
together and **Accept / Reject per hunk**, plus Retry with a refined prompt
without restarting. Escalation to the panel for anything multi-file.

Three unsolved things this phase must solve, not assume:

- **Blocks have no persisted identity.** Runtime ids only; save round-trips the
  whole document through `blocksToMarkdown`. "Rewrite this paragraph" needs an
  addressing scheme that does not exist.
- **No accept/reject primitive exists for editor content.** The only diff
  surface is `InlineDiff.tsx` at *file* granularity.
- **Decorations are unverified.** `useCreateBlockNote({ schema })`
  (`MarkdownEditor.tsx:182`) passes no `extensions`, and 0.46.2 is hard-pinned.
  Two private-API escape hatches already exist (`MarkdownEditor.tsx:307-311`,
  `chips.tsx:56`); a third is a smell, not a plan. Verify a ProseMirror
  decoration plugin is reachable **before** committing to in-buffer diffs.

Also: `onChange` fires for programmatic edits, so streaming insertion will
thrash the 500 ms debounce and flip the header to "Unsaved" continuously. And a
doc containing raw HTML is read-only behind a banner
(`MarkdownEditor.tsx:264-266`) — AI editing is simply unavailable there.

### M17.17 — Skills on a selection

Notion's move: the selection toolbar gets a **Skills** section, so a skill runs
against selected prose, not only against a chat turn. Same records, same
bodies, second entry point. The selection also becomes a context chip on the
panel thread (M17.6), so the two surfaces share one context model.

### M17.18 — The AI block

A block whose content is generated and can be recomputed — a summary, the open
questions, the action items. Persistent and in-document, distinct from the
transient rewrite.

---

## Phase 5 — Knowledge worth retrieving

### M17.19 — Search that ranks

`search_notes` is `haystack.contains(needle)`, unranked, truncated in scan
order (`mcp.rs:520-546`). The knowledge base's entire value is currently gated
behind the agent guessing the right substring. Ranked retrieval is the single
highest-leverage change in the knowledge layer, and it is upstream of every
"better knowledge base" idea.

This collides with `okf.ts:14-17` — *"Everything here is DERIVED, never
stored"* — because an index is the first derived state that cannot be
recomputed per render. Decide where it lives, how it invalidates, and what the
mock backend answers. (Related: `conceptEdges` is O(concepts² × relations ×
entries) and `listConcepts` runs at 12 call sites, one unmemoized on every
render at `DetailPanel.tsx:43-44`.)

### M17.20 — Knowledge reaches the conversation

`context.ts` carries selection, activeNote, linked, visible and references —
and **zero concepts**. The prompt only mentions that the bundle exists
(`AiPanel.tsx:522`). All the `about:` anchoring pays off in the UI and never in
the agent's reasoning. Whether that becomes injection or stays pull-via-tools
is a budget decision to make explicitly, against the finding that semantically
similar distractors hurt more than sheer length.

---

## Declared up front

- **`contradicts` and `refines` are fully built with zero instances in
  demo-vault** — every downstream surface is unit-fixture-tested only.
- **`lifecycle:` vs OKF's `status:`** — the promised export translation
  (`okf.ts:185`) does not exist, so the bundle is not OKF-conformant today.
- **View count is 9, not 6** (`types.ts:283-293`); the older 6-view note is
  stale, and `dashboard` is not a record view at all — it embeds saved views.
  "An agent scoped to a dashboard" needs a definition or a refusal.
- **Skill/Agent records are vault files**, so a shared vault can ship prompt
  instructions. Same trust boundary as `CLAUDE.md` in any repo — but M17.1
  closes the *invisible* half of it.
- **`git add -f`** — this file lives under a gitignored path, like every plan
  before it.
