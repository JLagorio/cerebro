---
name: verify-ui
description: Launch the app and prove a UI change in a real browser (a dev server on a free port, Playwright against the demo vault), knowing which jsdom passes lie. Use after any src/ change that renders, styles, focuses, drags or saves.
---

# verify-ui

A green vitest run says the logic holds, not that the app works. See the change
live, then pin it with a spec.

## What jsdom cannot prove

- jsdom has no layout: opacity versus visibility, geometry, focus and real
  pointer or wheel input stay unproven until a browser measures them.
- A BlockNote custom block (`createReactBlockSpec`) gets an extra wrapper
  element in a real browser and none in jsdom, so a child-combinator selector
  on `.bn-block-content` can pass every unit test and match nothing live.
- ProseMirror owns `.bn-block-outer` and wipes any attribute written onto it.
  Style an ancestor from a scoped `<style>` inside the node view instead.
- HTML5 drag and drop cannot be driven from our Playwright harness; that is
  why the block drag is a pointer gesture.
- A React `onPointerDown` inside a custom block never fires, because
  ProseMirror stops the event first. Bind the listener natively.
- A chip serialized during an unmount flush renders as nothing, so every chip
  needs a plain-text form in `chipText` (`src/editor/markdown.ts`).
- A synthetic `blur` event does not fire React `onBlur`; call `el.blur()`.

## Launch on a free port

- Never use 5173: it is the `devUrl` in `src-tauri/tauri.conf.json`, so the
  owner's running app may be loading it. Worktrees run their own servers, so a
  port that was free yesterday proves nothing.
- `lsof -nP -iTCP:<port> -sTCP:LISTEN` must print nothing. Then
  `PORT=<port> pnpm dev`; `vite.config.ts` sets `strictPort`, so a taken port
  fails instead of drifting.

## Drive it

- Write a Playwright script in a scratch folder and symlink the repo's
  `node_modules` into that folder, so `@playwright/test` resolves.
- Prefer that to chrome-devtools MCP, which often cannot start while the
  owner's Chrome holds its profile. Never close or kill the owner's Chrome.
- Boot the way `e2e/boot.ts` does: pin the clock to `VAULT_TODAY` when dates
  matter, set `cerebro.autoLearn` to `false` and `cerebro.themeMode` to
  `light` in an init script, then click "Open demo vault".
- `window.__cerebroMockFs` is the fake disk, a `Map` from vault-relative path
  to file text. Probing it writes nothing real, and a reload resets it.
- `[data-testid="detail-title"]` is an input: read `.value`, not its text.

## Lock it in

- Add or extend a spec under `e2e/` that imports `boot` (CV-15). A CSS claim
  gets a geometry assertion (`boundingBox`), not a DOM one.
- Run `PORT=<free> pnpm e2e`. Set `CEREBRO_E2E_REUSE=1` only for a server you
  started yourself.
- A slow or scattered run is usually the machine. Check `uptime` and
  `ps -eo pid,etime,command | grep worktrees`, ask before killing another
  session's processes, and re-run alone before debugging.

## What only a packaged build proves

- External links and the navigation guard (CV-16), timers in a hidden window,
  and the CSP in `src-tauri/tauri.conf.json`. Run `./scripts/mac-build.sh`, or
  say they were not checked.

## Report

- What was seen live, what passed only in jsdom, and what was not checked.
