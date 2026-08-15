# Security

Cerebro is a local-first desktop app. Understanding what it does — and
deliberately does not do — with your machine is most of its security story.

## The trust model

- **No API keys, no cloud.** The assistant is the Claude Code CLI already
  installed on your machine, spawned as a subprocess. Cerebro never holds a
  model credential and never proxies your notes through its own servers.
- **Loopback MCP only.** The app serves its vault tools over an in-process
  HTTP endpoint bound to `127.0.0.1` on an ephemeral port, authenticated with
  a bearer token handed to the CLI via a private `--mcp-config` file.
  `--strict-mcp-config` keeps the spawned agent from loading other MCP servers
  unless you opt in.
- **Tool permissions are enforced, not described.** The agent's permission
  mode (read-only / vault edits / power) is enforced by the allowlist passed
  to the CLI — read-only cannot name a single write tool.
- **Untrusted vaults cannot run commands.** A vault's
  `.cerebro/connectors.json` travels with the vault, so a stdio connector
  entry could name an arbitrary command. Stdio connectors therefore run only
  after a person approves that exact name+command+args+env fingerprint on
  this machine; approvals live outside the vault. Connector credentials are
  kept out of git by per-entry self-healing ignore rules.
- **The knowledge bundle is write-guarded.** `knowledge/` accepts writes only
  through `write_concept` (which stamps provenance server-side and refuses
  self-certification) and `verify_concept` (scoped to the `verified` key).

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
  no credentials and only asks `git credential fill` (from outside the repo,
  so the repo's own credential helpers never run) whether auth WOULD succeed.
  Cerebro pins off repo hooks and the `ext::`/fsmonitor vectors for every git
  it spawns, but fetch/pull necessarily run inside the repository and git
  honors that repository's remaining configuration there — **mounting a
  repository is an act of trust in its `.git/config`.**

**Decision (M32.12): agent exposure of mounted roots is OFF.** Revisiting it
requires, in one PR: root-scoped read-only MCP tools behind the existing
permission allowlist (read-only mode must cover them), per-call root
resolution with ambiguity-as-error for anything write-shaped, and an update
to this section. The guarded read path was built MCP-ready precisely so that
PR is small — the barrier is this trust model, on purpose.

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
