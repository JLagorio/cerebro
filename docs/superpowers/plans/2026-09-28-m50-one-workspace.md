# M50 — One workspace

**Why.** The owner, 2026-09-28, in the demo vault: "things feel disconnected
between the agents and the knowledge and the docs and the AI panel … we have
the plumbing but it all just feels disconnected, and the knowledge/base looks
like a separate UI." A screenshot pass plus a code map confirmed it. Each
surface grew its own version of the same things: its own layout, its own words,
and its own author.

**Owner decisions (2026-09-28).**

| Question | Decision |
|---|---|
| Can a concept be edited once it opens like a doc? | Editable. M49 already records in-app edits as `human:owner`. |
| One word for what the app has learned | **Knowledge**. "Base", "What the assistant knows" and "Ask the base" go away. |
| The Base sidebar section | A flat list: threads, plus All concepts and Needs review. Everything else moves to tabs on the Knowledge page. |
| Delivery | All five parts, uncommitted, verified at the end (as M49 was). |

## Parts

### M50.1 — A concept is a page

- A concept opens in `DocPage`, with the same breadcrumb bar, editor, side
  panel and save state as any page.
  - The breadcrumb reads Knowledge › section › title.
  - The title and description come from frontmatter and are editable through
    `updateFrontmatter`, which goes through the M23.7 capture valve.
  - The body's `#` headings are OKF sections, so they render at section size.
- The side panel gains a **Review** tab and opens on it for concepts. It holds
  what `KnowledgePanel` shows today: review state, what the concept rests on,
  about, related, written by, verified by, sources, tags, Verify, and Ask to
  revise.
- `KnowledgePage` stops being a three-column reader. Its lists (all, review,
  section, thread) fill the canvas, and a row opens the concept page. A
  `{kind:'knowledge', path}` deep link redirects to the concept page.
- Fixes:
  - `useOpenPath` and the Knowledge page no longer disagree about where a
    concept opens.
  - Vault-internal sources open.
  - Citation chips work.
  - Actions that refuse under `knowledge/` (Rename, Move, Template, Add page,
    Trash) leave the page menu for concepts.

### M50.2 — Knowledge where you work

- A one-line **Knowledge strip** under the header of every doc and record page:
  "Knowledge · 2 concepts · 1 unreviewed · 1 stale". Each concept is a link.
  It stays silent when there is nothing (nothing speaks first).
- The record panel's Knowledge section opens by default when it has content.

### M50.3 — One author

- "Written by" resolves the actor to its Agent record, by actor and never by
  name, and links to the agent. Other actors keep their label.
- The agent page gains **Wrote**: the concepts whose `generated.by` is this
  agent. Its run rows open the run.
- A run's detail lists the knowledge it changed. This is a new read-only IPC,
  `run_writes`: the applied ledger proposals whose `run_id` is that run, mapped
  to projection paths. The mock serves a seeded list.

### M50.4 — The AI panel follows the page

- On a doc or concept page, the page is the active record, so its knowledge
  goes into the snapshot. Today only the record peek did this.
- The composer shows which concepts the context carries ("Knowledge · 2"), and
  each one opens.
- Suggested prompts come from the page when there is one.

### M50.5 — One chrome, one vocabulary

- The Knowledge page header uses the app's anatomy (`h-11 px-4`, with the h1
  and count), and so do its tabs.
- The Base section becomes **Knowledge**, a single level: its threads, All
  concepts, and Needs review.
  - Folders, the update log, and the "what it knows about itself" tabs move to
    a tab strip on the Knowledge page.
  - The Agent work tab leaves Knowledge, because the fleet lives on Agents.
- Every UI string saying "base", "the knowledge base" or "What the assistant
  knows" says **Knowledge**.
- Off-token classes in the knowledge sections become DS tokens.

## Out of scope

- A run ID inside `generated`: it would change the projection format and the
  conformance vectors. M50.3 links runs through the ledger's own proposals
  instead.
- Runs inside the AI panel. The StatusBar `RunList` stays.
