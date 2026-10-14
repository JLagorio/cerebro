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
- **Tool permissions are enforced, not described.** One Settings switch, the
  shell ceiling, decides whether a run gets Bash and the CLI's own file tools.
  A run without it has the CLI's built-in writers (Write, Edit, MultiEdit,
  NotebookEdit, Bash) passed in `--disallowedTools`, so the CLI's own edit
  auto-approval cannot write around Cerebro's guards. A read-scoped run loses
  the shell and is denied the built-in readers (Read, Glob, Grep) too.
  Cerebro's own internal runs (ingest, maintenance, synthesis) are denied all
  of those, plus the web tools and Task. Cerebro's MCP tools enforce the rest
  themselves: a run's write scope, its read scope, the knowledge guard and
  the note-corpus doors. One write crosses a run's scope on purpose (D7): a
  run may rewrite the `recent` key, and nothing else, on its own Agent record,
  at most 30 lines and 4096 bytes. Every other key, and every other Agent
  record, stays refused. A write that names `expect_hash` is also a read, and
  is held to the read scope. The one tool that rewrites note text in place,
  `edit_note`, needs read access to the note as well as write access, because
  its refusals quote the note back. A vault's `allowed-tools:` can only narrow
  that grant, never widen it.
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
- **A page's comments live beside it, in `.comments/`** (M70.2). Each page's
  threads are `.comments/<page path>.json`; no comment ever writes the page
  itself. Git carries that folder like any other, so a pushed vault shares
  its comments. The scan, search and the agent's note tools never read or
  write it, and a sidecar linked out of the vault is refused like any escape.
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
