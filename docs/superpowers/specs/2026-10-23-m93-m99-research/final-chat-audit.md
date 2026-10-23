# Final focused M95 contract review

Baseline: active dirty HEAD `2347951`. Read-only review of repository files; no implementation or tests were run. Final correction paragraphs were reread after the author edited both M95 documents.

## Finding and disposition

**Important — displayed user question missing from archive producer contract: corrected in design.**

The original ArchiveTurnV1/begin_attempt contract described folded content and message IDs without explicitly supplying the displayed user message. `src-tauri/src/agent/mod.rs:82–87` documents UserPrompt as session-file-derived. `src/agent/useAgentChat.ts:743–754` separately creates displayed question text, while `:886–911` sends composed/addressed material to the CLI. Relying on assistant fold collection could omit the user bubble; reconstructing it from CLI input could retain prompt/context assembly contrary to CHAT-04.

The corrected M95 spec at `docs/superpowers/specs/2026-10-23-m95-chat-and-supervised-agents-design.md:207–225` includes the frozen display-only message in ArchiveTurnV1 and adds `displayMessage:{text,addressedLabel?,attachmentRefs}` to the prelaunch binding, bounded and subject to retention. It explicitly excludes reconstruction from CLI UserPrompt and persistence of outgoing/system prompt assembly. The paired M95 plan at `docs/superpowers/plans/2026-10-23-m95-chat-and-supervised-agents.md:110` carries the same boundary; `:121` adds `display_question_survives_missing_cli_file_without_prompt_assembly`.

This resolves the identified preimplementation ambiguity. The regression remains work to implement and execute.

## Remaining assessment

No remaining critical or important blocker found in the focused check of M95 producer/lifecycle, deferred/resumed generation identity, bounded partial recovery without rerun, distinct live journal/archive cursors, ACT effect signatures, KNOW inline locator signatures, and FLOW child submission interfaces. This is a focused contract review, not exhaustive approval of every implementation detail or all milestone documents.

## Claims declined

No runtime behavior, actual archive durability, safe prompt filtering, live/replay parity, native behavior, provider behavior or passing test gate is certified. M91's 11 unit and 42 E2E failures are quoted prior implementer reports, not independently reproduced results. Existing source establishes relevant seams, not completion of the proposed M95 archive. No repository files were edited by this reviewer.
