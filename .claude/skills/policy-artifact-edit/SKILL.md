---
name: policy-artifact-edit
description: Edit a rule artifact under shared/ (policy, runtime, schema, calendar or files) without breaking the byte anchor Rust and TypeScript share. Use before changing any file in those folders.
---

# policy-artifact-edit

A checklist only. The folders' READMEs hold the commands and the rules; where
this file and a README disagree, the README wins and this file gets fixed.

## Before the edit

- Read the folder's README first: `shared/policy/README.md`,
  `shared/runtime/README.md`, `shared/schema/README.md` (field kinds and view vocabulary),
  `shared/calendar/README.md` (the date grammar) or `shared/files/README.md`
  (file kinds), `shared/import/README.md` (import stamps and identity), or `shared/canvas/README.md` (JSON Canvas format and codecs).
  Its table names each
  artifact's readers, its Regenerating section is the procedure, and the
  policy README adds the Ordering rules and the twin registry.
- Rules are data (CV-04). A rule the table cannot express grows the format; it
  is never written twice, once in Rust and once in TypeScript. A vault
  semantic both languages hold is a D3 twin: shared cases, and a row in the
  policy README's twin registry.
- `policy.v1.json` and `policy.v2.json` are frozen negative controls: never
  edit them. The live table is `shared/policy/policy.v3.json`.
- A new refusal code declares its destiny (CV-06). When in doubt it is
  operational, and a ledger destiny needs a coverage-materiality argument in
  review.

## The edit

- Closed lists stay duplicate-free and canonical, per the Ordering rules:
  sorted in `policy.v3.json`, enum declaration order in
  `authority-routes.v1.json`.
- Never reformat a file there, whether by prettier, an editor or a JSON
  round-trip: the bytes are hashed, and `.prettierignore` skips each folder
  for that reason.
- An authority-routes edit bumps its versions first, and the new snapshot
  under `shared/policy/authority-routes/` joins `RESOLVABLE_ARTIFACTS` in
  `src-tauri/src/policy/authority.rs`.

## Regenerate and replay

- Regenerate the digest with the README's `#[ignore]`d writer test. On a Mac,
  every cargo run, these included, takes the crash skip list from the
  `cargo test` line in `.husky/pre-push`. Never `--skip kill`: it also skips
  the tests named for skills.
- The mail policy digest writer is `policy::mail::tests::write_mail_digest`;
  replay both mail readers, the pack tripwire and git exclusion checks.
- The import vocabulary digest writer is `import::tests::write_sources_digest`;
  replay `import::tests::` and the shared batch cases in both suites.
- The JSON Canvas format digest writer is `canvas::format::tests::write_canvas_digest`;
  replay its readers with the `canvas::` filter and `pnpm test:run src/engine/scene`.
- Whiteboard agent limits use `canvas::agent_limits::tests::write_canvas_agent_limits_digest`;
  replay `canvas::` plus `src/engine/scene/canvasLimits.test.ts`.
- The view vocabulary digest writer is `vault::views::tests::write_views_digest`;
  its raw-note cases are `src-tauri/fixtures/view-suggestion-cases.json`,
  replayed by Rust and the TS checker.
- Add or adjust goldens in `shared/policy/goldens/`,
  `shared/policy/goldens-critical/`, `shared/policy/goldens-trigger/` or
  `shared/policy/goldens-tool-approval/`. Both suites replay the same files,
  and a new critical trigger, trigger-registry refusal code or tool-approval
  cell fails the build until its vectors exist. A `tools.v1.json` edit that
  moves a CLI row's family changes the tool-approval goldens too.
- An artifact with no digest (`links.v1.json`, `staleness.v1.json`) carries
  `cases` that both readers replay; new behaviour gets a new case. So do the
  hashed `field-kinds.v1.json` and `dates.v1.json`, whose cases grow the same
  way, and `kinds.v1.json`, whose cases and refusals live in
  `src-tauri/fixtures/file-kind-cases.json`.
- Verify with `pnpm test:run src/lib/policy src/lib/attention src/lib/trigger`
  plus the TS reader the README names (`src/engine/fieldKindTable.test.ts`,
  `src/engine/dateGrammar.test.ts`, `src/engine/fileKinds.test.ts`,
  `src/engine/viewVocabulary.test.ts`, `src/engine/viewSuggestion.test.ts`), then
  `cd src-tauri && cargo test --lib -- policy:: attention:: trigger:: dynamics:: vault::schema vault::dates files::`
  with the skip list, adding the module of any other reader.

## Land it

- One commit holds the artifact, its digest, its goldens and its tests.
- Out of scope: `conformance/` (Rust-canonical vectors, regenerated with
  `UPDATE_CONFORMANCE=1` per `conformance/README.md`) and the parity fixtures
  in `src-tauri/fixtures/`.
