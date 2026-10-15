# Security

Cerebro is a local-first desktop app. Understanding what it does — and
deliberately does not do — with your machine is most of its security story.

## The trust model

- **No API keys, no cloud.** The assistant is the Claude Code CLI already
  installed on your machine, spawned as a subprocess. Cerebro never holds a
  model credential and never proxies your notes through its own servers.
- **Loopback MCP only.** The app serves its vault tools over an in-process
  HTTP endpoint bound to `127.0.0.1` on an ephemeral port. Each run gets its
  own bearer token as it spawns, handed to the CLI via a private
  `--mcp-config` file. The token is bound to that run's vault and grant,
  compared in constant time, and revoked 10 s after the run's process exits,
  or at once if the run never started. The endpoint has no token of its
  own, and the app's window never holds one. Each request must also be
  addressed to the endpoint itself: a Host other than `127.0.0.1` or
  `localhost` on the app's port, or a browser `Origin` other than `http://`
  and one of those, is refused before the token is read, so a web page
  cannot reach the endpoint by rebinding a domain name to 127.0.0.1 or by
  posting to it from its own origin. These refusals are answered and never
  recorded in `runtime.db`, as an unauthorized request never was; the
  diagnostic log notes the first of each kind per launch.
  `--strict-mcp-config` keeps the spawned agent from loading other MCP
  servers unless you opt in.
- **Ending a run ends its process group.** The CLI runs as the leader of its
  own process group. Stop, a vault switch and quit send that group TERM, wait
  2 s, then send KILL, so what the run started inside the group ends with it.
  A process that starts its own session (`setsid`) leaves the group and
  escapes that signal; Cerebro trusts the CLI to end its own shells on TERM,
  which is why TERM comes first.
- **Tool permissions are enforced, not described.** Shell access in Settings
  is off, ask or on (M57.2), and one table,
  `shared/policy/tool-approval.v1.json`, turns it into what each run may do
  with the CLI's own tools. Off denies the built-in writers (Write, Edit,
  MultiEdit, NotebookEdit) and Bash in `--disallowedTools`, so the CLI's own
  edit auto-approval cannot write around Cerebro's guards. On pre-approves
  them and the built-in readers. Ask leaves the writers and Bash out of both
  lists and starts the run in Claude Code's `default` mode, so each call
  meets Cerebro's gate and waits for your card; a run whose start reports
  another mode or a Claude Code older than 2.1.250 is stopped before it acts.
  Ask asks only in a conversation you are watching: a scheduled run under Ask
  is denied those tools instead, and its run records which. This
  conversation allows only the exact command or path the card named, in
  memory, for that conversation. Your own Claude Code allow rules and hooks
  act before Cerebro asks, so a command they allow runs without a card, and
  Settings counts them beside the switch. A writer or the shell an agent's
  `allowed-tools:` leaves out is denied at every ceiling. A read-scoped run
  loses the shell and is denied the built-in readers (Read, Glob, Grep) too.
  The plan tool is refused, by the gate or in argv; the question tool asks
  you only in a conversation you are watching (M57.3, below) and is denied in
  argv everywhere else. Cerebro's
  own internal runs (ingest, maintenance, synthesis) are denied every CLI
  tool, the web tools and Task included. Cerebro's MCP tools enforce the rest
  themselves: a run's write scope, its read scope, the knowledge guard, the
  note-corpus doors and an ask-first agent's Allow (next items). One write crosses a run's scope on purpose (D7): a
  run may rewrite the `recent` key, and nothing else, on its own Agent record,
  at most 30 lines and 4096 bytes, and every other byte of the record stays as
  the person wrote it, comments included. Every other key, and every other
  Agent record, stays refused. A write that names `expect_hash` is also a read, and
  is held to the read scope. The one tool that rewrites note text in place,
  `edit_note`, needs read access to the note as well as write access, because
  its refusals quote the note back. Both scopes bind where a note path lands
  as well as how it is spelled, so a symlink inside a scope cannot carry a
  read or a write out of it. A vault's `allowed-tools:` can only narrow
  that grant, never widen it. The argv decides every call but one a run may
  stop to ask you about (next item): that tool is left out of the allow list
  and meets Cerebro's gate instead.
- **A run can wait for you, and only you can answer** (M57.1). A run that may
  ask carries one PreToolUse hook in its own settings file (owner-only,
  removed with the run). The hook rides the run's own bearer to Cerebro's
  loopback, and there it can only register a wait in its own conversation and
  read your decision; no MCP tool, hook or bearer records an answer. Your
  answer enters only through the app's answer command. A tool that may ask is
  never pre-approved in argv, so a hook that fails, times out or is switched
  off refuses the call. A call still waiting when you press Stop, switch
  vaults or quit is refused as not answered the next time its conversation
  goes on.
- **An ask-first agent's page writes wait for your Allow** (M57.4). An Agent
  record that says `ask-first: true` (any value but `true` or `false` reads
  the same, failing closed) has its page writes, the tools the manifest marks
  `confirmable` (create, append, edit and frontmatter on notes), shown to you
  on a card before they land. Rust reads `ask-first:` from the agent's own
  record when its run starts, so the app's renderer can only tighten it.
  Cerebro's dispatch is the boundary: such a write reaches disk only by
  taking an approval the app's answer command recorded when you pressed
  Allow, bound to its vault, Claude Code session, agent, tool and input,
  used once and good for ten minutes. Your own Claude Code allow rules
  and hooks can make the CLI call the tool sooner; they can never approve
  it, and a write with no approval is refused and recorded against its run.
  A run nobody watches cannot ask, so an ask-first agent's page writes wait
  for you in Review instead (M57.4c, next item). Its own `recent` notes
  never ask (D7).
- **A page write queued for Review touches nothing until you allow it**
  (M57.4c). Pending writes live in `runtime.db`, in the app's data folder,
  outside the vault and outside git, and hold the agent's draft verbatim,
  with the grant of the run that queued it. A write is queued only once it
  passes every check it could pass then, on the bytes on disk; nothing
  reaches disk before you press Allow. Allow re-runs every guard under the
  queuing run's stored grant (its write and read scopes, its tool grant, the
  note corpus, the knowledge bundle, Type docs and Agent records, and a
  stale hash) under the write's own lock, and it never queues the write
  again; a second decision is refused as already decided. Your edit there
  is checked the same way and records nothing. One agent may have at most
  20 writes waiting, of at most 256 KiB each; nothing expires. The agent's
  next unattended run is told what became of each, once, with your reason
  and every vault path quoted as data.
- **You may edit an ask-first draft before Allow, and the edit never widens
  the agent's grant** (M57.4b). The card's form is projected from the tool's
  input schema. Rust re-checks your edit when you answer (its shape against
  the schema, then the run's write and read scopes, its tool grant, the note
  corpus and the knowledge bundle, under the grant the run was started
  with, and since M57.4c the write itself previewed on the bytes on disk),
  and a refusal comes back to the card and records nothing. It is
  checked again at the write, under the write's own lock, with the same
  guards as any agent write, Type docs and Agent records included. The
  approval holds the asked input's hash and your version; dispatch lands
  your version whichever of the two the CLI sends, and tells the agent which
  keys you changed.
- **The agent's questions are yours to answer, and only as text** (M57.3).
  When an agent asks you a question mid-turn (Claude Code's AskUserQuestion),
  its questions, options and previews are the agent's words: the card shows
  them as plain text, never as HTML, and a preview stays folded until you open
  it. Cerebro checks your answer's membership and counts (every question
  answered once, every pick one of its options, Other at most 2000
  characters with control characters removed) before it reaches Claude Code,
  as the call's own input. A question set the card cannot show is refused,
  and the agent is told why. The permission prompt tool Cerebro names on a
  run you watch allows only a call you answered, and refuses every other. A run nobody watches is never offered the tool,
  and every unattended run's message says that nobody will answer.
- **A turn you closed the panel on is held in memory, never on disk**
  (M57.6). Closing the assistant or switching threads leaves a run going,
  so its events are held for the panel to re-attach: only a run you watch,
  at most 4 MiB and 20,000 events a run and 16 MiB in all, for 30 minutes
  after it ends or after its waiting card closes. They are never written to
  disk, and are dropped at a vault switch and at quit. A re-attach names the
  run's durable id, so a run number reused after a restart reads nothing.
- **Untrusted vaults cannot add callable servers.** A vault's
  `.cerebro/connectors.json` travels with the vault, so a stdio connector
  entry could name an arbitrary command, and an http one a server of the
  vault's choosing. An entry therefore reaches a run only after a person
  approves its exact spec on this machine: name+command+args+env for stdio,
  and for http its name, URL, headers and, when present, `oauth`. Settings
  approves what it adds; a hand-edited or downloaded entry waits for Approve,
  and any edit asks again. Approvals live
  outside the vault, as SHA-256 digests, never the specs themselves, since env
  values and headers are credentials. Connector credentials are kept out of
  git by per-entry self-healing ignore rules. `connectors.json` is written
  owner-only (0600), and opening a vault narrows one an older build left
  readable, but it stays plaintext at rest: anything that can read your
  account's files can read it.
- **An http connector reaches Claude Code as type, URL, headers, oauth and
  timeout, and nothing else** (M69.1). `headersHelper` would run a command,
  `tools` and `toolPermissions` would pre-approve tools past the run's grant,
  and the rest is Cerebro's to set, so none of them is passed. `oauth` is part
  of what you approve, because an `authServerMetadataUrl` can send the
  sign-in to another server and `scopes` widen what it grants; it passes only
  `clientId`, `callbackPort`, an https `authServerMetadataUrl` and one
  `scopes` string, never a client secret. An entry whose `oauth` or `timeout`
  Claude Code would refuse is left out of the run, so it cannot make the CLI
  refuse every other server with it. The Linear and Notion presets sign in
  through Claude Code's own `/mcp`, under the name the preset writes; the
  token stays in Claude Code's keychain entry and never in Cerebro. Removing
  an entry never signs you out: clear its authentication in `/mcp`.
- **Connector tools are granted by name, and records only subtract.** A run
  may call a connector's tools only when the connector is listed, enabled,
  approved on this machine and left in by the run's record; Cerebro then
  passes it in `--allowedTools` as `mcp__<name>`, spelled the way Claude Code
  hears the server name. An Agent record narrows that with `connectors:`,
  with `mcp__<name>` or `mcp__<name>__<tool>` entries in `allowed-tools:`,
  and with `disallowed-tools:`, which keeps a whole server from loading or
  passes a tool in `--disallowedTools`; none of the three can add anything.
  A run nobody watches reaches only the connectors its record names, so a
  scheduled agent without `connectors:` reaches none. Cerebro's own internal
  runs and handed-to runs reach none. Server names that could be read as
  another server's (one holding `__`, starting or ending with `_`, longer
  than 40 characters, or Cerebro's own name in any case) are refused, and so
  are two names Claude Code would hear alike. Every entry Cerebro puts in
  argv holds only letters, digits, `_` and `-`. With no `connectors.json`, a
  turn you watch loads your own global MCP config but Cerebro grants none of
  its tools, and a turn that names a connector anywhere (`connectors:`,
  `allowed-tools:` or `disallowed-tools:`) loads none of it, because a bound
  on a connector holds only against the vault's list. Your own Claude Code
  allow rules still apply to every run and can widen a record's tool-level
  allowlist for a server; a deny always wins, so a read-only agent should
  also deny the destructive tools, spelled exactly as the server names them.
  A denied tool is withdrawn from the run, so the model never sees it; a
  call to a loaded tool outside the grant is refused by Claude Code and
  recorded, by tool name, under its run in `runtime.db`.
- **The knowledge bundle is write-guarded.** `knowledge/` accepts writes only
  through `write_concept` (which stamps provenance server-side and refuses
  self-certification), `recheck_concept` (which moves `stale_after` and
  nothing else, and refuses a concept a person verified) and `verify_concept`
  (scoped to the `verified` key).
- **Every write says who made it, and an agent cannot write as you**
  (M58.1). Each vault write carries a receipt its door's guard mints: your
  commands stamp `human:me`, an agent's tools stamp the run's actor and run
  from its grant, and a write you allowed names you as its approver while
  keeping the agent as the actor. Only the commands the app's window calls can
  mint your receipt; no MCP tool reaches that guard, so no agent write is
  recorded as yours. The record is operational, in `runtime.db`'s
  `vault_writes`, never the vault's ledger, and it observes writes without
  gating them. Writes that pass no door (another editor, a sync, git, an
  agent's own shell) record nothing, and a run whose plan let the shell run
  says its record may be partial.
- **A page's comments live beside it, in `.comments/`** (M70.2). Each page's
  threads are `.comments/<page path>.json`; no comment ever writes the page
  itself. Git carries that folder like any other, so a pushed vault shares
  its comments. The scan, search and the agent's note tools never read or
  write it, and a sidecar linked out of the vault is refused like any escape.
- **A deleted page waits in the vault's own Trash, `.trash/`** (M60.8). A
  delete moves the page and its comments to `.trash/<stamp>/`; nothing a
  person deletes is unlinked. `.trash/` is gitignored, so a pushed vault
  never carries a deleted page, and the scan, search and Cerebro's agent
  tools never read or write it. Claude Code's own readers (Read, Glob, Grep)
  can still open it until M60.8b denies them, and a shell-granted run always
  can. Restore refuses to overwrite, a `.trash` linked out of the vault is
  refused like any escape, and at launch items past 30 days move to the
  macOS Trash.
- **Agents can comment on pages they can read** (M70.3). comment_on_note,
  reply_to_comment and resolve_comment write only the page's comment
  sidecar, never the page, and are held to read scope (a refusal lists where
  a quote appears, so it is a read) and to the tool grant, not to write
  scope. A run posts at most 20 comments. Comment text reaches agents quoted
  as data.
- **A person's @mention in a thread runs one turn** (M70.4). A person's
  comment that names an agent runs one turn of that agent, under its own
  scope, read scope and tools, with no shell, web or connectors, booked to
  Fleet with the page as its cause. Only a person's comment starts one; an
  agent's comment never does. Cerebro posts the answer in place of the
  placeholder, and a deleted placeholder drops it. An agent that cannot read
  the page is not asked, because the question quotes the page.
- **Claude Code's session files are read back, never copied** (M56.3).
  Claude Code writes each conversation's transcript under its own config
  folder, keyed by the vault's path, outside the vault. Cerebro reads a
  vault's session file back, read-only, to rebuild a thread whose cached copy
  is gone, folds it as it reads, and stores no new copy of it. A session id
  is accepted only as a lowercase UUID, before any run starts or any path is
  built, so a stored id can neither become a Claude Code flag nor reach a
  file outside that vault's projects folder.
- **A run's detail folds its session file only when asked** (M56.9). Claude
  Code keeps session transcripts under its own `projects` folder, outside the
  vault, and Settings names and purges them. A run's detail reads that file,
  read-only, when you open its Transcript; Cerebro stores no copy, and after
  Claude Code's cleanup (30 days by default) the run says so. The fleet reads run history
  through a connection SQLite opens read-only.
- **A model and an effort reach argv only after Rust checks them** (M56.5).
  An Agent record's `model:` and `effort:`, and a conversation's pick, become
  `--model` and `--effort` only after `src-tauri/src/agent/run_options.rs`
  has checked them against `shared/policy/run-options.v1.json`: an effort
  must be one of its five levels, and a model name starts with a letter or
  digit and holds only letters, digits and `._-:@/[]`, at most 128 of them,
  so no value can be read as a flag or carry a space or a control character.
  The check runs before any token, lease or run row exists, again before a
  handed-to run starts, and again before the child is admitted. Each value
  is its own argv element, never passed through a shell.
- **A vault cannot choose who the panel answers as** (M56.6). Settings binds
  a vault's assistant panel to an Agent record by its handle, and the binding
  is the app's own `config.json`, keyed by vault path, never a file in the
  vault. A handle outside the slug grammar is refused before anything is
  written. A bound turn runs under that record's grant, like a turn that
  names it with `@`: its actor, write and read scope, tools and connectors,
  under the Settings shell ceiling, and a paused agent's turn is refused. A
  binding no record answers to sends as the plain assistant, and the panel
  says so.
- **Open with opens two kinds of target, and nothing else.** A markdown note
  inside the vault, judged by the note writers' own door (no dot-paths,
  non-notes, `views/`, `attachments/` or symlinks out), which Finder reveals or
  the default app opens; or a link built from one of the four agent-link bases
  in `shared/policy/agent-links.v1.json`, with the prompt percent-encoded and
  the whole link at most 8192 bytes. Each goes to `/usr/bin/open` as one
  argument, never through a shell, and the clipboard is written through
  `/usr/bin/pbcopy`. A prompt carries the page's vault-relative path, never
  its absolute one, so a link to claude.ai does not carry your home folder's
  name (M55.9).

## Mounted repositories (M30/M32)

Cerebro can mount additional directories — typically work repositories —
beside the vault. The trust model for a mounted root:

- **Cerebro exposes no mounted-root tools to the agent.** MCP tools are
  vault-scoped; none of the `root_*` commands are agent tools. Scope this
  claim honestly: with the shell ceiling enabled, the CLI's own tools
  (Bash/Read/…) reach anything your user account can read, mounted or not —
  this decision governs Cerebro's guarded surface, not the operating system.
  Mounted repositories may contain code the user does not have the right to
  share (employer code); widening Cerebro's surface is a deliberate decision,
  not a default (see below).
- **Reads are guarded**: path containment after canonicalization, a 2MB
  ceiling, binary sniffing (`src-tauri/src/roots/read.rs`).
- **Git operations are read-only plus fetch/fast-forward pull.** Cerebro
  never commits to, pushes from, or resolves conflicts in a mounted
  repository; a pull that would need a merge is refused (`--ff-only`); and
  sync refuses a root mounted inside a larger repository (`parent_repo`) — it
  would act on a repo you never mounted. Auth is system git's: Cerebro stores
  no credentials, and its readiness probe only asks `git credential fill`
  (from outside the repo, so the repo's own credential helpers never run)
  whether auth WOULD succeed. Cerebro pins off repo hooks and the
  `ext::`/fsmonitor vectors for every git it spawns, but fetch/pull
  necessarily run inside the repository and git honors that repository's
  remaining configuration there — **mounting a repository is an act of trust
  in its `.git/config`.**

**Decision (M32.12): agent exposure of mounted roots is OFF.** Revisiting it
requires, in one PR: root-scoped read-only MCP tools granted per run like
every other tool (an Agent record's `allowed-tools:` and `read-scope:` must
be able to exclude them), per-call root resolution with ambiguity-as-error
for anything write-shaped, and an update to this section. The guarded read
path was built MCP-ready precisely so that PR is small — the barrier is this
trust model, on purpose.

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository (GitHub private
vulnerability reporting is enabled) for anything sensitive — it opens a
private advisory only you and the maintainer can see. For anything that does
not expose user data, a public GitHub issue is fine. Include steps to
reproduce and what a successful exploit would reach. There is no bounty
program; there is a genuine intent to fix what you find.

## Out of scope

- Anything requiring an already-compromised machine or vault ownership.
- The Claude Code CLI itself (report to Anthropic).
- Denial of service against your own local app.
- Cloud coding agents, GitHub App webhooks and server-side code execution:
  Cerebro ships none of them.
