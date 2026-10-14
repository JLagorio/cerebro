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
      "Immutable releases". It reads back now, though M32.4 found no API for
      it: `gh api repos/JLagorio/cerebro/immutable-releases --jq .enabled`
      was `false` on 2026-10-13. Once ON, do the dry-run **before the next
      real release**: push a `v0.0.1-rc` tag, confirm
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
- [x] Actions fork-PR policy: "Require approval for first-time
      contributors". Verified:
      `actions/permissions/fork-pr-contributor-approval` →
      `approval_policy: first_time_contributors`. (M32.4 left this unticked:
      `actions/permissions/access` returns 422 on a public repo, and it found
      no other endpoint.) It gates the PR-triggered lanes (`scanners.yml`,
      `cargo-deny.yml`), not `quality`/`e2e`: `mac-app.yml` runs on pushes
      only (M53.1), so a fork's PR never runs them here.
- [x] Private vulnerability reporting: ON (M32.12), and SECURITY.md's
      reporting section points at the Security → "Report a vulnerability"
      flow. Verified by VALUE, not by exit code — a bare GET on this endpoint
      exits 0 whether `enabled` is true or false, so check
      `gh api repos/JLagorio/cerebro/private-vulnerability-reporting --jq .enabled`
      (`true` on 2026-10-13).
- [x] CodeQL default setup: ON, advisory, `default` query suite (M32.5).
      Languages: `actions`, `javascript-typescript`. **Rust is NOT covered** —
      default setup rejects it (422; allowed values are actions, c-cpp,
      csharp, go, java-kotlin, javascript-typescript, python, ruby, swift),
      so `mcp.rs`, `agent/` and `connectors.rs` get no taint tracking from
      anything: clippy does not do taint analysis either. Registered as a
      deferral in the M32 plan. Re-check when GitHub ships Rust support.
      Verified: `gh api repos/JLagorio/cerebro/code-scanning/default-setup`.

## Bypass log

(none)
