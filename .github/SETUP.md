# Externally-configured state (not enforceable from the repo)

Settings live server-side; this checklist is their only in-repo witness.
If you change a setting, change this file in the same sitting. Do NOT
document workflow behaviour here — workflows document themselves inline.

A ticked box means the state was **verified**, and says how. An unticked box
is honest: either it is not done yet, or it cannot be read back and nobody
should pretend otherwise.

- [x] Ruleset `protect-main` (id 20887280): deletion + non-fast-forward
      blocked; PRs required with checks `quality`, `e2e` (strict); 0
      approvals (solo — reviews would be theater); admin bypass exists and
      **using it is an incident** — note the date and reason below.
      Verified: `gh api repos/JLagorio/cerebro/rules/branches/main`.
- [x] Ruleset `protect-release-tags` (id 20887282) on `refs/tags/v*`: no
      update/delete/move. Verified: `gh api repos/JLagorio/cerebro/rulesets`.
- [ ] **Immutable releases: NOT YET ON.** Settings → General → Releases →
      "Immutable releases". There is no API surface for this toggle
      (`PATCH /repos/{o}/{r}` ignores it), so it cannot be scripted or read
      back — which is exactly why this file exists. Once ON, do the dry-run
      **before the next real release**: push a `v0.0.1-rc` tag, confirm
      `gh release view v0.0.1-rc --json isImmutable` is `true`, and confirm
      `gh release delete v0.0.1-rc` is REFUSED. Immutability is forever per
      release — a botched one can only be superseded, never fixed.
- [x] Dependabot alerts + security updates: ON (M32.3). Verified:
      `vulnerability-alerts` returns 204 and
      `security_and_analysis.dependabot_security_updates` is `enabled`.
- [x] Secret scanning + push protection: ON (pre-existing). Verified in
      `security_and_analysis`.
- [x] Actions default workflow token: read-only (setting mirrors the
      workflow-level `permissions:` block — belt and suspenders). Verified:
      `actions/permissions/workflow` → `default_workflow_permissions: read`.
- [ ] Actions fork-PR policy: should be "Require approval for first-time
      contributors" (the GitHub default). **Not API-readable on a public
      repo** — `actions/permissions/access` returns 422 ("only applies to
      internal and private repositories") and there is no fork-pr-workflows
      endpoint. Confirm by eye in Settings → Actions → General → "Fork pull
      request workflows from outside collaborators", then tick this.
      It matters more since M32.1: PRs now execute PR-controlled code in
      `quality`/`e2e`, and this setting is the approval gate in front of that.
- [ ] Private vulnerability reporting: verify ON; SECURITY.md points at it
      (M32.12).
- [x] CodeQL default setup: ON, advisory, `default` query suite (M32.5).
      Languages: `actions`, `javascript-typescript`. **Rust is NOT covered** —
      default setup rejects it (422; allowed values are actions, c-cpp,
      csharp, go, java-kotlin, javascript-typescript, python, ruby, swift),
      so `mcp.rs`, `agent.rs` and `connectors.rs` get no taint tracking from
      anything: clippy does not do taint analysis either. Registered as a
      deferral in the M32 plan. Re-check when GitHub ships Rust support.
      Verified: `gh api repos/JLagorio/cerebro/code-scanning/default-setup`.

## Bypass log

(none)
