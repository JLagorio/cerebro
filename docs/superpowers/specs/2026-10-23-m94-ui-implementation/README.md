# M94 — UI implementation evidence

Status: in progress. The owner authorized implementation on the shared
`m53-macro-port` branch while Claude implements M92. This directory records
comparison evidence; no aesthetic, native or milestone acceptance is implied.

The first comparison implements opt-in collection and utility compositions in
the existing `PageHeader` and surface stylesheet. Pages is now the first
application consumer under review; other production consumers retain their
existing geometry. A dev-only specimen renders the real
primitives at exact host widths; current application captures remain separate.
See the [role sheet](composition-sheet.md) and [interaction results](interaction-results.md).

## Source reconciliation

Starting commit: `6c92709187ee0f1c54a049be23b7717eeb3dfcae`. The worktree is dirty
and shared; HEAD alone does not identify a browser capture. Capture manifests
record content hashes and the observation window, including concurrent edits.
No branch, index or contributor files have been reset to manufacture a clean
baseline.

Source-confirmed on 2026-10-23:

- `agent/transcript.ts` already folds ordered text/reasoning/tool parts and
  nested child runs. `ChatTurn.tsx` already renders the shared AI elements and
  branching controls. There is no new flat-reducer replacement in M94.
- `AiPanel.tsx` already mounts the M92 conversation rail and shares one
  `useContextUse` reading between the composer and Context card. M94 leaves
  these active M92 files with Claude; no coherent final M92 handoff has arrived.
- Subagent and approval facts already come from their shared policy artifacts
  and Rust/TypeScript readers. UI layout does not create capabilities or alter
  the foreground/depth/concurrency grants.
- The document still uses first-H1 projection and a stable metadata portal;
  the full-height panel, 64px toolbar, 54px rail and 240px default sidebar remain
  existing owners. PageHeader compositions do not style authored document titles.

Historical M91 evidence is not recertified here. Its reported unit baseline
(`ConceptTable` ×8, `sidebarChrome`, `ListPage`, `TypePage`) belongs to a final
pinned integration gate; the reported browser baseline likewise remains
unresolved until classified against the current source. M91.R/live CLI and
native IME/VoiceOver are separate acceptance owners. The earlier policy-loader
startup failure was not observed in these browser runs and is not asserted as
a current defect.

## Observation categories

| Category | Current evidence | Limit |
| --- | --- | --- |
| Source | Current modules and paired plan/spec inspected | Concurrent M92/M93/M99 changes require a final source freeze |
| Browser | Composition geometry and light/dark captures | Dev Chromium; synthetic content and mock filesystem |
| Application baseline | Four-surface capture fixture | Results and images recorded after the run; no visual migration yet |
| Native | None in this M94 slice | WKWebView, 900×600 native window, IME and VoiceOver remain unverified |
| Live CLI | None in this M94 slice | M91/M92/CHAT evidence is not replaced by browser fixtures |

The role specimen is reachable in dev at
`/state-lab.html?composition=collection&width=600&theme=light` or
`composition=utility`. Add `variant=current` for the same primitives without
the proposed roles. It reads no vault, credentials or preferences and is
excluded from the production entry. These are comparison scenes, not claims
that a connector check or page creation ran.

## Owner composition decision — 2026-10-25

The owner accepted the refined treatment for wider collection/utility adoption. [Decision and scope](../2026-10-25-m94-refined-composition-decision.md). Earlier captures and their limits remain unchanged; later surfaces still require implementation and verification.
