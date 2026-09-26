# Knowledge system audit — 2026-09-25

Triggered by the live-vault banner **"Knowledge history diverged … (1 unresolved). Automatic capture
is paused until you choose."** (`src/app/ReconciliationBanner.tsx`), open on `~/Documents/test` since
2026-08-17 (ledger seq 180).

## Method

- 10 lens auditors (read-only) → every finding adversarially verified: high/critical by 2 independent
  refuters (code-correctness, reachability), medium/low by 1.
- Completeness critic → 3 follow-up auditors → same verification.
- Synthesizer deduplicated F1–F119 into **K1–K46** and wrote the remediation plan.
- Totals: 119 raw findings, 119 survived verification (verifier corrections
  and downgraded severities are recorded inline in each lens file). 188 agents, branch
  `m45-layout-editor`, no code changed.

## How to read

- Start with **00-report.md** — it is the deduplicated, corrected view (K-IDs). Each K entry lists the
  F-IDs it merged.
- The lens files are the raw evidence (F-IDs), with each verifier's verdict, reasoning, and correction
  under a collapsible block. Where a verifier corrected a claim, the correction wins.
- Live-state details (pids, ports) describe the machine on 2026-09-25 and will go stale.

## Pre-audit incident facts (verified by hand before the workflow)

- seq 180 `ledger.divergence`, signals `[manifest_reducer_disagreement]`, 3/30 paths:
  `decisions/gcs-5-supervision-ratio.md`, `risks/tx-6-changeover-transient-cross-channel-sync-disabled.md`,
  `risks/tx-6-np-shared-j12-common-mode.md`.
- seq 179 (same scan): `log.md` captured as a `human:owner` out-of-band override.
- Five vault autosync commits 2026-08-17 11:51–11:57Z rewrote the 3 concepts with the ledger head
  unchanged (`619957fc…`) — zero ledger events.
- Capture refused the 3 as "provenance forgery" (`generated` stamp changed) → mode opened;
  `resolve_accept_with` hits the same refusal, so "Keep my files" cannot succeed.

## Files

- [00-report.md](00-report.md) — Synthesized report — what the banner means, what to do, root cause, K1–K46, M49 plan, owner questions
- [01-forensics.md](01-forensics.md) — Incident root cause — F1–F8 (8 findings)
- [02-write-census.md](02-write-census.md) — Write-path census — F9–F18 (10 findings)
- [03-recovery-ux.md](03-recovery-ux.md) — Reconciliation recovery & UX — F19–F28 (10 findings)
- [04-capture-classifier.md](04-capture-classifier.md) — Capture valve & F/M/R classifier — F29–F38 (10 findings)
- [05-ledger-core.md](05-ledger-core.md) — Ledger core integrity — F39–F45 (7 findings)
- [06-parity-policy.md](06-parity-policy.md) — TS↔Rust parity & policy-as-data — F46–F54 (9 findings)
- [07-ingest-agent.md](07-ingest-agent.md) — Ingest / distill / agent pipeline — F55–F66 (12 findings)
- [08-vault-data.md](08-vault-data.md) — Live vault data audit — F67–F76 (10 findings)
- [09-ui-invariants.md](09-ui-invariants.md) — Knowledge UI vs project invariants — F77–F88 (12 findings)
- [10-architecture.md](10-architecture.md) — Architecture & proportionality — F89–F98 (10 findings)
- [11-critic.md](11-critic.md) — Completeness critic — 3 gaps
- [12-gap-verified-lossless-exit-for-the-live-vault-the-us.md](12-gap-verified-lossless-exit-for-the-live-vault-the-us.md) — Follow-up: Verified lossless exit for the live vault (the user's 'what do I do now') — F99–F105 (7 findings)
- [13-gap-knowledge-read-side-and-trust-model-how-verified.md](13-gap-knowledge-read-side-and-trust-model-how-verified.md) — Follow-up: Knowledge read side and trust model (how verified knowledge can be overridden and what agents are served) — F106–F113 (8 findings)
- [14-gap-root-cause-adjudication-two-processes-vs-same-pr.md](14-gap-root-cause-adjudication-two-processes-vs-same-pr.md) — Follow-up: Root-cause adjudication: two processes vs same-process reopen (contradictory, both unverified) — F114–F119 (6 findings)
