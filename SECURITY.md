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

## Reporting a vulnerability

Please open a GitHub issue for anything that does not expose user data, or
email the maintainer (see the git log) for anything sensitive. Include steps
to reproduce and what a successful exploit would reach. There is no bounty
program; there is a genuine intent to fix what you find.

## Out of scope

- Anything requiring an already-compromised machine or vault ownership.
- The Claude Code CLI itself (report to Anthropic).
- Denial of service against your own local app.
