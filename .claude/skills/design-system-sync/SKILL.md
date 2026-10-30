---
name: design-system-sync
description: Rebuild the Cerebro design-system artifact from this repository and publish it with the Artifact tool. Use after a change to src/styles/tokens, src/components/ui, src/components/ai, the shell CSS, or anything under design-system/, or when asked to sync, refresh or republish the design system.
---

# design-system-sync

The artifact named in `design-system/system.json` is generated: every value
comes from the app, every word from `design-system/`. Never edit the artifact
on its page and never hand-copy a value into it; change the source, rebuild,
publish.

## Build

1. `pnpm ds:build` writes `design-system/out/project/` and
   `design-system/out/publish.json`. It fails on drift: a token with no note in
   `design-system/tokens.notes.json`, a note with no token, a card in
   `system.json` with no folder or no `@dsCard` marker on line 1. Fix the cause
   in the repo, never the output. It warns on a component module with no card:
   add a card or list the module under `uncarded` with its reason.
2. A new or changed card: follow the shape of
   `design-system/project/components/Button/preview.html` (one root, one
   script, `React.createElement` against `window.Cerebro`, no network), then
   render it in both themes in a real browser before publishing (`verify-ui`).

## Publish (Claude Code, Artifact tool)

1. Uploads: for each entry in `publish.json` `uploads` (an icon the artifact
   lacks or that changed), publish it with `asset: true` to the artifact's url,
   up to 25 per call, then record its blob id, size and sha256 under its name
   in `design-system/icons.json`.
2. Index: `read` `project/design-system.json` from the artifact, save it, and
   run `pnpm ds:build index <that file> --by "<person's name>" --note "<one line>"`.
   It keeps every key the page owns and refuses while an icon lacks a blob.
3. One publish: `url` from `publish.json`, `root: design-system/out`,
   `file_path` the index, `files` every other path in `publish.json` `files`;
   each path in `textPlain` goes as `{from, contentType: "text/plain"}`. Send
   only what changed when you know it; the index always goes last.
4. Commit `design-system/icons.json` if it changed. `design-system/out/` is
   ignored.

## Rules

- Values: tokens from `src/styles/tokens/`, the bundle from
  `src/components/ui/` and `src/components/ai/` plus `extraModules`. Changing a
  colour means changing `src/styles/tokens/colors.css` (its contrast checks in
  `src/styles/contrast.test.ts` hold).
- Shell cards (AppShell, AppRail, Sidebar, PageToolbar) are compositions of
  the app's real markup and classes, because those components read app state.
  When `src/app/shell.css`, `src/app/AppRail.tsx` or `src/app/Sidebar.tsx`
  change, re-read them and update those cards.
- Never delete an uploaded asset or archive a card without the owner asking.
