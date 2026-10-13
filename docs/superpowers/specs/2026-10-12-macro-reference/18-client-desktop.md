# Macro reference — Client runtime and native shells: WASM GraphQL cache, offline, Tauri desktop/iOS/Android

**Scope**: Macro's client runtime and native shells, read 2026-10-12 from `docs/examples/macro-main/` (vendored,
gitignored). Macro paths are relative to that root. Cerebro paths are relative to the repo root (prefix `cerebro:` where
ambiguous). `reg:` = `~/.cargo/registry/src/index.crates.io-*/`.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: `LICENSE.txt` (AGPL-3.0) covers `crates/client/*`, `crates/native_app_service` and `nix/*`.
`apps/web/LICENSE` reads "All rights reserved" and covers `apps/web/tauri/**`, `apps/web/src/lib/**`,
`apps/web/public/sw.js` and `apps/web/docs/*`. **Nothing here is reusable as code.** The Tauri forks
(`macro-inc/tauri` 957785f5, `macro-inc/tao` 6cbc7628) are not vendored. The only permissive sources are upstream
Tauri plugins (Apache-2.0 OR MIT) and objc2 crates.
**Evidence**: stages 1–2 read code; stage 3 re-read both trees and the crates in Cerebro's lockfile. No packaged build
was run and no Macro code was executed. Stage 3 overrides stages 1–2. Cerebro line numbers are from the uncommitted
working tree.

---

## 1. What it is

- A Rust normalized GraphQL cache (`crates/client`: cache-core + cache-turso + turso-opfs + cache-wasm, ~60.6k LOC,
  ~32k of it tests) behind one TS `CacheHost`. Tauri hosts it natively (a single engine shared by all webviews). The
  browser runs it as WASM in an elected worker over OPFS. On top sit a urql exchange, a durable optimistic mutation
  queue, an identity witness and live field patches.
- A Tauri 2 shell on a patched fork with about 15 plugins. Desktop gets single-instance, deep links, a navigation
  guard, an overlay title bar and a signed updater. Mobile gets OTA bundles and about 10 Swift/Kotlin plugins.
- For Cerebro (files-first, single user, no server, macOS only) the cache, OTA and mobile parts are skip. The shell
  hygiene and a few small client utilities are what to take.

## 2. What users get

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Offline cached reads | Policies cache-first / cache-and-network / network-only / cache-only. Stale data, then fresh. A network failure re-reads cache-only. The hot LRU holds 10k records. Tauri stores `{app_data_dir}/graphql-cache/cache.turso`. | `crates/client/cache-core/src/engine.rs`, `apps/web/src/lib/graphql-cache/exchange/normalized-cache-exchange.ts`, `apps/web/tauri/graphql_cache_plugin/src/commands.rs` |
| Durable optimistic edits | Applied instantly, persisted with a replayable request, replayed in strict order. A caller stuck behind the head gets a synthetic `queued`. Backoff min(1s·2^(n-1), 60s). The 10th server failure rolls back; transport failures don't count. Each attempt has a 60s timeout inside a 5-min lease. | `apps/web/src/lib/graphql-cache/exchange/mutation-queue-runner.ts:60-65,151-152`, `crates/client/cache-core/src/queue.rs` |
| Undo/redo | Global LIFO of compensating actions. A toast undoes its own entry via a handle; ⌘Z / ⇧⌘Z act on the top. A failed non-top undo is restored in place; a new action retires the redo branch, in-flight redos included. Entries can bind to a hotkey group. | `apps/web/src/lib/queries/undo.ts` |
| Multi-window consistency | One engine for every webview or tab. Events `graphql-cache://ops-affected`, `cache-changed` and `mutation-settled` are filtered by a `{clientId}:` prefix. Old tabs get a reload prompt. | `apps/web/tauri/graphql_cache_plugin/src/lib.rs`, `apps/web/src/lib/graphql-cache/worker/coordinator-core.ts` |
| Local search / filters / calendar | Quick Access, Soup/Mail filters and calendar viewports are answered from projection tables. A filter is a bounded probe of max(64, 2·limit). | `crates/client/cache-core/src/search.rs`, `crates/client/cache-core/src/calendar.rs` |
| Account isolation | Logout clears every registered cache plus backfill cursors. A response for another user wipes and rebinds. A failed wipe rotates the anonymous scope UUID (`graphql-cache:scope`, Web Lock CAS). | `apps/web/src/lib/graphql-cache/lifecycle.ts`, `apps/web/src/lib/graphql-cache/scope.ts` |
| Desktop chrome | `titleBarStyle: Overlay`, traffic lights at {16,20}, a 40px drag bar with `pl-[88px]`, backgroundThrottling disabled. Grants `core:window:allow-start-dragging`. | `apps/web/tauri/src-tauri/tauri.conf.json`, `apps/web/src/components/app/DesktopTitleBar.tsx`, `apps/web/tauri/src-tauri/capabilities/macos.json` |
| Deep links + link routing | `macro://` and `https://(dev.|staging.)macro.com/app/...` open in-app. Links that arrive early are buffered (latest wins) until `flush_launch_deep_link`. External URLs open in the system browser. | `apps/web/tauri/src-tauri/src/lib.rs`, `apps/web/tauri/navigation_plugin/src/lib.rs`, `apps/web/src/lib/tauri/navigation.ts` |
| Desktop auto-update | macOS arm64 and Linux AppImage. Signed GitHub feed checked every 6h (retry 60s → 1h). Installs on quit. "Restart to update" flushes registered saves (15s cap) and refuses during calls, uploads and imports. | `apps/web/tauri/src-tauri/src/desktop_update/desktop.rs`, `apps/web/src/lib/tauri/native-updates.ts`, `apps/web/tauri/desktop-release.json` |
| OTA bundles (mobile) | Wi-Fi-only download, sha256 check, `.complete` marker, `tauri://` asset swap, reload ack. Revoke → embedded bundle; a stale native build → update-required dialog. | `apps/web/tauri/macro_bundle_updater_plugin/src/domain/service.rs`, `crates/native_app_service/src/domain/service.rs` |
| Notifications | APNs and data-only FCM push. On macOS the real permission comes from UNUserNotificationCenter, because the plugin always says "granted". | `apps/web/tauri/src-tauri/src/macos_notification_permission.rs`, `apps/web/src/lib/tauri/notification.ts` |
| Mobile integrations | Share targets, pasteboard staging (24h), photo picker, CallKit + LiveKit + PiP, haptics, IME/insets, edit-menu suppression, Android Back, native network status. | `apps/web/tauri/callkit_plugin`, `apps/web/tauri/android_mobile_plugin`, `apps/web/tauri/network_status_plugin` |
| Web service worker | Stale-while-revalidate shell plus cache-first hashed assets. Off in Tauri and dev. An idle old tab reloads within 10s. Kill switch: `macro:sw=off`. | `apps/web/src/lib/service-worker/register.ts`, `apps/web/public/sw.js` |
| Memory recording | `--record-memory`: 1 Hz host + WebKit RSS, 3600-sample ring, attached to OTel spans. Uses a private SPI. | `apps/web/tauri/src-tauri/src/diagnostics.rs` |
| Batched previews | 30ms / 50-item dataloader, 3 attempts from 200ms; ref-counted live batches. | `apps/web/src/lib/queries/preview/dataloader.ts`, `.../preview/live-batcher.ts` |

## 3. How it's built

- **Engine** (`cache-core`): SDL parsed at runtime (apollo-compiler). Any type with `id: ID!` becomes an entity keyed
  `__typename:id`. Normalize/denormalize, hot LRU, `DepIndex` (record → active ops), durable queue, projections and
  `watch_query` patches, all over an async `Storage` trait.
- **Storage** (`cache-turso`): frozen schema v11 on turso_core (git pin), postcard blobs. Incompatible or uncertain
  state is **physically reset, never migrated**. Slow SQL is logged by FNV fingerprint, with no SQL text.
- **Hosts**: Tauri has 26 `graphql_cache_*` commands with an `EngineHandle` behind a tokio Mutex, and changes are
  broadcast as events. The browser host uses a SharedWorker coordinator, an elected dedicated worker running wasm,
  Web Locks, owner epochs and an Effect transport. IPC timeout is 10s, except non-idempotent enqueue.
- **Shell**: Tauri fork plus Tao fork (cold-start URL fix). Per-platform plugin sets, with single-instance registered
  first. A `tauri://` wrapper for OTA. `DeepLinkDelivery`. `csp: null`. tracing → **stderr only**; no file, no panic
  hook (`apps/web/tauri/src-tauri/src/lib.rs:129-138,194-199`).

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| cache-core | `crates/client/cache-core` | Engine, deps index, durable queue, identity witness, projections, live patches | 33.5k |
| cache-turso | `crates/client/cache-turso` | Turso storage, frozen schema, strict-head leasing, physical reset | 16.1k |
| turso-opfs | `crates/client/turso-opfs` | wasm OPFS IO; typed open/connect/close/reset states | 5.1k |
| cache-wasm | `crates/client/cache-wasm` | wasm-bindgen `CacheEngine`, 38 exports | 5.8k |
| graphql_cache_plugin | `apps/web/tauri/graphql_cache_plugin` | Native host, 26 commands, event broadcast | 3.9k |
| graphql-cache JS | `apps/web/src/lib/graphql-cache` | `CacheHost`s, exchange, queue runner, scope and lifecycle | 51.0k (17.8k prod) |
| urql-solid | `apps/web/src/lib/urql-solid` | Solid bindings that keep object identity | 4.0k |
| Tauri shell | `apps/web/tauri/src-tauri` | Builder, plugins, deep links, protocol, updater, diagnostics | 3.1k |
| navigation_plugin | `apps/web/tauri/navigation_plugin` | `on_navigation` allowlist → app route / system browser | 534 (lib.rs 246) |
| desktop_update | `apps/web/tauri/src-tauri/src/desktop_update` | Updater coordinator | 352 |
| bundle updater | `apps/web/tauri/macro_bundle_updater_plugin` | Hexagonal OTA state machine | 4.9k |
| native_app_service | `crates/native_app_service` | Server OTA policy + AASA | 1.2k |
| mobile plugins | `apps/web/tauri/*_plugin` | CallKit, push, pasteboard, photos, IME, network, Android | 9.7k |
| frontend tauri | `apps/web/src/lib/tauri` | Provider, navigation bridge, update prep, notifications | 1.8k |
| query utils | `apps/web/src/lib/queries` | undo (268), trailing-refetch (32), visible-changes (78), IDB persistence, previews | 12.7k |
| nix | `nix` | crane builds, AppImage, DMG + codesign, dev shells | 1.1k |

**Data model**

| Entity | Storage | Key fields | Path |
| --- | --- | --- | --- |
| Cache DB | Turso file / OPFS `graphql-cache:{scope}:s{epoch}.v{fmt}.t{storage}` | `records`, `mutation_queue` (uuid, lease_owner, lease_generation, attempt_count, next_attempt_at_ms), `optimistic_layers`, projection shadows, calendar ranges; failures counted in meta | `crates/client/cache-turso/src/storage.rs` |
| Optimistic envelope | `optimistic_data_json`, v3 | identity_bindings, link_patches, revalidations, projection_mutations | `crates/client/cache-core/src/queue.rs` |
| Schema superset | `graphql-cache/schema.json` | additions merged, removals retained | `apps/web/tauri/graphql_cache_plugin/src/commands.rs` |
| Per-query IDB | `{name}-{scope}-persist-v1` | buster, maxAge, generation fence | `apps/web/src/lib/queries/persistence/per-query-idb.ts` |
| OTA store | numbered dirs + `.complete`, `bundle_root` | `BundleManifest{bundleBuild, minNativeBuild(s)}` | `apps/web/tauri/macro_bundle_updater_plugin/src/domain/models.rs` |

**Key flows**

*Cached read + invalidation (Tauri)*
1. `createLiveQuery`. The exchange chain is optimistic → revalidation → normalizedCache → subscription → fetch
   (`graphql-soup.ts:618-643`).
2. `graphql_cache_read`/`watch` over IPC (10s). The engine denormalizes from the LRU and batch-loads the misses.
3. A miss goes to fetch; `graphql_cache_write` normalizes and writes in one transaction. It returns changed keys,
   affected ops (origin excluded) and field changes.
4. The events broadcast; each window filters by clientId and re-executes or applies patches in one Solid batch.

*Durable optimistic mutation*
1. The resolver predicts the root field; `nowMs` is computed once, with a 5-min lease.
2. Enqueue has no IPC timeout. Under the lock: queue row + layer + shadows are written atomically (a UUID collision
   supersedes), then the strict head is claimed.
3. Events are emitted only after the claim. If the claim is ours, send (60s). If an older one is claimed, replay it
   and return `queued`. Otherwise return `queued` and let the drain take over.
4. Success → commit + identity bindings. Retryable → defer with backoff. Permanent or the 10th server failure →
   rollback. Then `mutation-settled`, and the drain moves to the next head.

*Deep link*
1. The OS delivers the URL (desktop via single-instance, iOS via the Tao fork, Android via an intent filter).
2. `DeepLinkDelivery` buffers it, latest wins, until the frontend is ready.
3. The frontend calls `listen('navigate')`, then `flush_launch_deep_link`, which delivers exactly once.
4. Inside the webview, `on_navigation` cancels app links and re-emits them, allows the allowlist, and sends the rest
   to the system browser on a detached thread.

*Desktop update*
1. Check every 6h, plus immediately on a NativeUpdateRequired bundle event. The signed bytes are held in memory.
2. Install on `ExitRequested`. "Restart" runs prepare (15s, refuses while busy), then `restart_native_update`.

## 4. Ideas worth stealing (ranked)

1. **The navigation guard owns links, not each surface.** One Rust hook gives the allowlist, the system browser for
   external links and in-app re-routing. `apps/web/tauri/navigation_plugin/src/lib.rs`.
2. **Trailing refetch: one pending read with a guaranteed trailing re-read.** It kills overlapping, out-of-order
   refreshes. `apps/web/src/lib/queries/trailing-refetch.ts`.
3. **Launch-link buffer: latest wins, flushed exactly once by the frontend.** No cold-start loss and no
   re-navigation on remount. `apps/web/tauri/src-tauri/src/lib.rs`, `apps/web/src/lib/tauri/navigation.ts`.
4. **Preparation registry before a controlled exit.** Mounted savers register, prepare is bounded, and it refuses
   while work is live. `apps/web/src/lib/tauri/native-update-preparation.ts`, `native-updates.ts:49-79`.
5. **Global undo with targeted handles and generation fencing.** `apps/web/src/lib/queries/undo.ts`.
6. **Never trust a plugin's permission answer; read the OS.** `apps/web/tauri/src-tauri/src/macos_notification_permission.rs`.
7. **backgroundThrottling disabled** for a window whose timers matter. `apps/web/tauri/src-tauri/tauri.conf.json`.
8. **`queued` is a typed result, not an error.** Claim before fan-out, and keep the server-failure budget separate
   from transport retries. This matches Cerebro's proposal-channel results. `mutation-queue-runner.ts`,
   `apps/web/docs/graphql-cache-optimistic-enqueue-claim-plan.md`.
9. **Changed keys → dependency index → field patches.** `crates/client/cache-core/src/deps.rs`,
   `.../engine/watch_query.rs`, `apps/web/src/lib/graphql-cache/exchange/query-patches.ts`.
10. **Disposable stores reset physically; a storage-generation UUID fences stale cursors.**
    `crates/client/cache-turso/src/storage.rs`, `crates/client/README.md`.
11. **A bounded IPC timeout on everything idempotent.** `apps/web/src/lib/graphql-cache/host/tauri-host.ts:86-99,148-161`.
12. **Model-based oracle tests over transient states.** `apps/web/docs/graphql-cache-testing.md`,
    `crates/client/cache-core/tests/support/optimistic_model.rs`.
13. **Slow-SQL telemetry by template fingerprint.** `crates/client/cache-turso/src/query_telemetry.rs`.

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | value | note |
| --- | --- | --- | --- |
| Navigation guard / system browser | absent | high | 9 `target=_blank` sites, `LinkBadges.tsx:80` `window.open`, and BlockNote LinkToolbar Open/Download. tauri 2.11.5 `from_config` leaves `new_window_handler: None` and wry returns nil → dead in the packaged app (source-confirmed, not clicked) |
| backgroundThrottling disabled | absent | medium | Hidden window may suspend on macOS 14+ (documented, not measured). Schedules catch up via `lastFireKey` → **late, not lost** |
| Coalesced refresh | absent | medium | `rescan()` (`vaultStore.ts:185-205`) has no dedupe or order. Live race: optimistic `patchFrontmatter` vs an in-flight scan, and nothing corrects it |
| Exit preparation | absent | medium | Only `RunEvent::Exit`. 500ms save debounce, flushed only on unmount. `stop_all` has no caller; claude children and grandchildren outlive the app |
| Structured logging | partial | medium | 34 `eprintln!`, no logger installed; Tauri's and wry's `log::error!` also go nowhere |
| Real notification permission | partial | medium | Web Notification + toast (`useReminders.ts:47-60`) |
| Deep links | absent | medium | The routing exists (UiAction `open_note`/`navigate`) |
| Global undo | partial | medium | Per surface only (BlockNote, mermaid, Inbox bar, `revert_application`) |
| Overlay title bar | absent | low | M43: the sidebar is the chrome, under a native bar |
| Field patches from changed keys | partial | low | Unit `vault-changed` event + full rescan; the M17.12 diff is the event source |
| Visibility-gated refresh | partial | low | In `useGit` only. Rescans must not be gated (triggers ride them) |
| Single-instance | different-by-design | low | Per-vault flock, holder label, Not-recording banner (M49.2) |
| Signed auto-update | absent | low | M32 non-goal (key custody). Repo is public; one release, v0.1.0 |
| Normalized offline cache / durable queue | different-by-design | low | Disk is the truth; job claims already use leases (`runtime/dispatch.rs`) |
| Multi-window consistency | different-by-design | low | One window; Rust owns state; `app.emit` broadcasts |
| Account isolation | partial | low | Backend better (store_uuid, ForeignWriter). Frontend reminder keys and body caches are not scoped by vault |
| Disposable derived stores | already-better | low | Ledger index rebuilds from segments (M21.5) |
| Bounded network IPC | absent | low | `git/command.rs:79-93` has no timeout on fetch/pull/push |
| OTA bundles, mobile plugins, push, SW | absent | low | No server; macOS only |
| Memory sampling, slow-SQL telemetry | absent | low | Private SPI; runtime.db is small |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CLIENT-DESKTOP-1 | External links open in the system browser; webview never leaves the entry document | rebuild | adapt | S | high | `apps/web/tauri/navigation_plugin/src/lib.rs`, `apps/web/tauri/src-tauri/src/lib.rs`, `apps/web/src/lib/tauri/macroLinkInterceptor.ts` | `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/shell/links.rs` (new), `shared/policy/links.v1.json` (new), `src/mermaid/flowchart/linkTargets.ts`, `src/mermaid/flowchart/svgLinks.ts` | — |
| CLIENT-DESKTOP-3 | Coalesced, ordered rescans with a write-generation fence | rebuild | adapt | S | medium | `apps/web/src/lib/queries/trailing-refetch.ts` | `src/stores/vaultStore.ts`, `src/lib/trailingRefresh.ts` (new), `src/stores/vaultStore.test.ts` | — |
| CLIENT-DESKTOP-4 | Clean quit: kill agent process groups on Exit; custom Quit + CloseRequested flush | rebuild | adapt | M (part a: S) | medium | `apps/web/src/lib/tauri/native-update-preparation.ts`, `apps/web/src/lib/tauri/native-updates.ts` | `src-tauri/src/lib.rs`, `src-tauri/src/shell/quit.rs` (new), `src-tauri/src/agent/mod.rs`, `src/app/quitPreparation.ts` (new), `src/editor/MarkdownEditor.tsx`, `src/editor/NoteBodyEditor.tsx`, `src/mermaid/useDiagramFile.ts`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts` | process-group spawn (shared with DOMAIN:agents) |
| CLIENT-DESKTOP-2 | Keep the webview awake while hidden (`backgroundThrottling: "disabled"`) | rebuild | mirror | S | medium | `apps/web/tauri/src-tauri/tauri.conf.json` | `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs` (config test) | — |
| CLIENT-DESKTOP-5 | Durable local diagnostic log (own appender behind `log`) | rebuild | inspire | S | medium | `apps/web/tauri/src-tauri/src/logging.rs`, `apps/web/tauri/logger/src/lib.rs` | `src-tauri/src/logging.rs` (new), `src-tauri/src/lib.rs`, `src-tauri/src/ingest/ambient.rs`, `src-tauri/src/agent/meter.rs`, `src-tauri/src/runtime/*.rs`, `src-tauri/src/assembly/ask.rs`, `src-tauri/src/conflict/resolve.rs`, `src-tauri/src/policy/qualification.rs`, `src/main.tsx` | — |
| CLIENT-DESKTOP-6 | Reminders reach Notification Center via UNUserNotificationCenter, honest permission | rebuild | adapt | M | medium | `apps/web/tauri/src-tauri/src/macos_notification_permission.rs`, `apps/web/src/lib/tauri/notification.ts` | `src-tauri/src/shell/notify.rs` (new), `src-tauri/src/lib.rs`, `src/hooks/useReminders.ts`, `src/pages/SettingsPage.tsx`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts` | CLIENT-DESKTOP-2 |
| CLIENT-DESKTOP-7 | `cerebro://` deep links via Info.plist + `RunEvent::Opened`, launch buffer | rebuild | adapt | M | medium | `apps/web/tauri/src-tauri/src/lib.rs` (DeepLinkDelivery), `apps/web/src/lib/tauri/navigation.ts` | `src-tauri/Info.plist`, `src-tauri/src/shell/deep_link.rs` (new), `src-tauri/src/lib.rs`, `src/agent/AgentActions.tsx`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `e2e/deep-link.spec.ts` (new) | CLIENT-DESKTOP-1, DOMAIN:shell, DOMAIN:mcp |
| CLIENT-DESKTOP-8 | Global undo/redo for plain vault writes, hash-guarded | rebuild | adapt | L | medium | `apps/web/src/lib/queries/undo.ts` | `src/stores/undoStore.ts` (new), `src/stores/vaultStore.ts`, `src/app/listActions.ts`, `src/components/MoveDialog.tsx`, `src/components/FileTree.tsx`, `src/app/ToastHost.tsx`, `src/App.tsx`, `src-tauri/src/lib.rs`, `src-tauri/src/vault/write.rs`, `src/lib/mockIpc.ts` | DOMAIN:editor |
| CLIENT-DESKTOP-9 | macOS overlay title bar under the sidebar header | rebuild | adapt | S | low | `apps/web/tauri/src-tauri/tauri.conf.json`, `apps/web/src/components/app/DesktopTitleBar.tsx`, `apps/web/tauri/src-tauri/capabilities/macos.json` | `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src/app/Sidebar.tsx`, `src/app/Sidebar.test.tsx` | DOMAIN:shell |
| CLIENT-DESKTOP-15 | Gated bump tauri 2.11.5 → 2.12.x (+ `@tauri-apps/api`/`cli` same commit) | adopt-upstream | — | S–M | low | — | `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `package.json`, `pnpm-lock.yaml` | CLIENT-DESKTOP-18 |
| CLIENT-DESKTOP-16 | Vault-scope reminder fired-keys and doc body caches | rebuild | inspire | S | low | `apps/web/src/lib/graphql-cache/lifecycle.ts` | `src/hooks/useReminders.ts`, `src/engine/reminders.ts`, `src/hooks/useDocTasks.ts` | — |
| CLIENT-DESKTOP-17 | Bounded git network runner (typed timeout → unavailable) | rebuild | inspire | S | low | `apps/web/src/lib/graphql-cache/host/tauri-host.ts` | `src-tauri/src/git/command.rs`, `src/git/useGit.ts`, `src/git/SyncBadge.tsx` | DOMAIN:coding |
| CLIENT-DESKTOP-18 | Versioned packaged-smoke checklist for shell phases | rebuild | inspire | S | low | `apps/web/tests/native/runner.ts` (contrast only) | `docs/superpowers/` checklist (new) | — |
| CLIENT-DESKTOP-10 | Incremental rescans from watcher paths (only if a measured budget is breached) | rebuild | inspire | M | low | `crates/client/cache-core/src/deps.rs`, `crates/client/cache-core/src/engine/watch_query.rs`, `apps/web/src/lib/graphql-cache/exchange/query-patches.ts` | `src-tauri/src/vault/watcher.rs`, `src-tauri/src/vault/scan.rs`, `src/stores/vaultStore.ts`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts` | CLIENT-DESKTOP-3, DOMAIN:search |
| CLIENT-DESKTOP-11 | Signed updater, manual "Install and restart" only, gated on key custody | adopt-upstream | — | L | low | `apps/web/tauri/src-tauri/src/desktop_update/desktop.rs`, `apps/web/src/lib/tauri/native-updates.ts`, `apps/web/tauri/desktop-release.json` | `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `.github/workflows/mac-app.yml`, `scripts/mac-package.sh`, `src/pages/SettingsPage.tsx` | CLIENT-DESKTOP-4, -5, -15 (or pin updater ≤2.12.0) |
| CLIENT-DESKTOP-12 | Skip: normalized cache, durable queue, multi-tab coordinator, service worker | skip | — | — | low | `crates/client/cache-core/src/queue.rs` | — | revisit if a network write path appears |
| CLIENT-DESKTOP-13 | Skip: OTA bundles, mobile shells and plugins | skip | — | — | low | `apps/web/tauri/macro_bundle_updater_plugin` | — | revisit if iOS ships |
| CLIENT-DESKTOP-14 | Skip: tauri-plugin-single-instance | skip | — | — | low | `apps/web/tauri/src-tauri/src/lib.rs` | — | revisit if Windows/Linux ship |

Per-candidate specifics:

- **1**: `create: false` + `WebviewWindowBuilder::from_config` in setup, keeping label `main`. Attach `on_navigation` +
  `on_new_window`; plugins can't hook new windows. Pure `classify(url)`: **Allow** `tauri://localhost/` or
  `/index.html` with any `#fragment`, plus the devUrl root under `cfg(debug_assertions)`. **External** for http(s),
  via `/usr/bin/open` on a spawned thread. **Deny** everything else, other same-origin paths included. Cerebro
  creates no iframes. The scheme list lives in `shared/policy/links.v1.json` with replayed cases, read by Rust and
  `linkTargets.ts`. Delete the falsified comments (`svgLinks.ts:17-23`, `linkTargets.ts:8`) and recheck
  `svgBinding.ts:260-266`.
- **3**: The coalescer resolves and never rethrows; it toasts once per failed cycle and keeps the last good snapshot.
  A write counter is bumped by `patchFrontmatter` and every non-rescanning optimistic writer. A scan started before the
  bump discards its snapshot and requests a trailing scan. `openVault` joins the same coalescer. No visibility
  gating. House precedent: `useGit.ts:59-67`, `vaultStore.ts:133-153`. Acceptance: 5 calls in flight → 2
  `scanVault` calls; out-of-order resolution never installs the older snapshot; no reverse trigger events in
  `useJobRunner.ts:214-230` diff tests.
- **4**: (a) Ship first, size S. On `RunEvent::Exit`: `stop_all` synchronously, spawn in a process group, TERM then
  KILL the group, close meter rows as interrupted, and also call it on vault retarget. (b) Replace `Menu::default`
  with an equivalent menu whose Quit is a custom ⌘Q `MenuItem`: emit `will-quit`, run prepare, then `app.exit(0)`.
  Rust owns the 3–5s deadline. (c) `WindowEvent::CloseRequested` → `prevent_close` → prepare → destroy. (d) Document
  that Dock Quit, logout and shutdown cannot flush. (e) Confirm before quitting while agent runs are live. The
  registry reuses `flushPendingSave` (`MarkdownEditor.tsx:371`) and `flushRef` (`useDiagramFile.ts:93`). Unlike
  Macro, it isolates failures (allSettled) and never throws.

Other candidates in brief:

- **2**: config test asserts `app.windows[0].backgroundThrottling == "disabled"`. Measure with an hourly/daily
  schedule + a reminder that come due after ≥10 min minimized; record fire time vs due time before and after.
  No-op below macOS 14.
- **5**: about 80 lines, size-capped, under `app_config::app_dir()/logs` (per checkout in dev). Panic hook +
  `log_frontend`. Then deny `clippy::print_stderr`, with each suppression giving its reason. Redaction tests (MCP bearer,
  `mcp_url` token, connector env, note bodies). Never a third record for refusal codes. Use plugin-log only if pinned
  `=2.9.2`.
- **6**: `objc2-user-notifications` 0.3.2, `block2`, `objc2-foundation` are already in `Cargo.lock`, so no new
  crate. Guard the bundle id; an unbundled dev build reports `unknown`. Fallback: plugin `=2.4.0`, and its silent
  `show()` never counts as delivered. Scope: user-set reminders only.
- **7**: `cerebro://open?store=<uuid>&path=<rel>`, `cerebro://go?to=<surface>`. UI-only, never writes. A different
  vault needs a confirm; a missing page toasts and creates nothing. Fetch the pending link once at module scope
  (StrictMode-safe, `main.tsx:7`), not in an effect. Dev builds don't register; worktree release bundles share
  `com.cerebro.app`.
- **8**: new hash-guarded write commands (existing signatures unchanged); reuse refusal code `stale_view`. Never
  `knowledge/` or proposal decisions. A hotkey-precedence layer over 22 listeners and 3 ⌘Z handlers. Inbox keeps its
  on-screen bar. Revisit the "This cannot be undone" copy (`DocProperties.tsx:410`, `PropertyEditor.tsx:72`).
  Create/delete inverses deferred.
- **9**: add `core:window:allow-start-dragging` (not in `core:window:default`, `reg:tauri-2.11.5/build.rs:113`).
  Drop the inset in fullscreen. Offset the collapsed cluster. Owner design call.
- **10**: fallbacks on rename pairing, yml changes and `Flag::Rescan`. Needs a hand-rolled seeded oracle generator
  (no `[dev-dependencies]`) and a new large-vault generator to set the budget.
- **11**: manual check only; every result stated in words. Never install-on-quit (⌘Q never raises `ExitRequested`).
  No startup call. Needs owner reversal of M32 plus key custody.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| `csp: null` | Strict CSP | Keep the CSP; everything runs over `ipc:` |
| Rust allowlist + TS link interceptor | Policy is data, no twin rules | `shared/policy/links.v1.json` read by both (CLIENT-DESKTOP-1) |
| Trailing refetch rethrows | Human-UI store actions never throw | Coalescer resolves; toast once; keep the last snapshot |
| Visibility-gated refresh | M17.12 triggers ride rescan diffs | Never gate rescans; keep the webview awake (CLIENT-DESKTOP-2) |
| Prepare uses `Promise.all`, throws when blocked | Never throw; one failure must not mask others | allSettled + bounded; a block becomes a confirm |
| Global undo, blind compensations | Knowledge guarded; proposals typed; disk truth | Plain writes only; hash-checked; stale → `stale_view` refusal |
| Plugin says "granted" | Absent is never zero | Read UN; unreadable → `unknown` |
| Deep links into any route | Opening a vault arms the ledger writer and ambient | UI-only; confirm on vault switch; never write |
| tracing → stderr / OTLP | Local-only; two records, two destinies | Local file, no export, redacted, not a refusal record |
| 6h updater poll, phone-home | SECURITY.md no cloud; M32 non-goal | Manual, opt-in, after key custody |
| Single-instance on identifier | M49.2 per-checkout isolation | Skip; per-vault flock is the guard |
| `tauri-plugin-x = "2"` | Lock is tauri 2.11.5 | Pin a ^2.10-compatible release or wait for CLIENT-DESKTOP-15 |
| House crate rule (`writer.rs:978-980`) | No dependency duplicating std | `/usr/bin/open` over opener; own appender over plugin-log |

## 8. Verification notes (stage 3)

- **Refuted: ExitRequested can intercept ⌘Q.** The default menu's Quit → muda `terminate:` (`macos/mod.rs:994`). tao
  0.35.3 implements only `applicationWillTerminate` → `RunEvent::Exit`. `ExitRequested` fires only after the last
  window is destroyed, or on `app.exit`/restart (`tauri-runtime-wry lib.rs:4309-4323,4352-4365`). → CLIENT-DESKTOP-4
  redesigned around a custom Quit + CloseRequested.
- **Refuted: Macro's prepare is failure-isolated and never throws.** It throws when blocked and uses `Promise.all`.
  It runs only on "Restart to update"; only PDF and Canvas register. Isolation is Cerebro's adaptation.
- **Refuted: Macro guides file logging.** Stderr only, no file, no panic hook → CLIENT-DESKTOP-5 becomes
  rebuild/inspire.
- **Refuted: `classify` may allow `tauri://localhost/*`.** That keeps M29's off-SPA hazard live. With no router,
  entry document + fragment is the safe set.
- **Refuted: the rule can be Rust-only.** `linkTargets.ts:24-31` already implements it in TS → shared policy.
- **Refuted: only one comment is falsified.** `svgLinks.ts:17-23` and `linkTargets.ts:8` are falsified too.
- **Refuted: FSEvents coalesces to directories.** notify requests file-level events (`fsevent.rs:276`).
- **Refuted: private repo / install-on-quit for the updater.** The repo is public; install-on-quit never runs on ⌘Q.
- **Refuted: `mac-build.sh` does no codesign.** It calls `mac-package.sh` (ad hoc).
- **Corrected**: 103 commands, not 105. CLIENT-DESKTOP-2's value drops high → medium (late, not lost; 1-min schedules
  don't exist). CLIENT-DESKTOP-8 effort M → L. Every current upstream plugin needs tauri ^2.12 → new CLIENT-DESKTOP-15.
  Deep links need no plugin on macOS (`register()` unsupported; it re-emits core `RunEvent::Opened`). CLIENT-DESKTOP-6
  avoids the plugin (silent `show()`, `com.apple.Terminal` identity in dev).
- **Partial**: CLIENT-DESKTOP-9 needs `allow-start-dragging`. CLIENT-DESKTOP-14 no longer claims "macOS blocks a
  second copy"; the skip rests on `/tmp/{identifier}_si.sock` + `exit(0)`. Account isolation holds for the backend
  only → CLIENT-DESKTOP-16.
- **Folded in (missed)**: BlockNote LinkToolbar `window.open` (→1). Optimistic patch vs scan race (→3).
  CloseRequested close path and grandchild leak (→4). Unscoped reminder keys (16). Unbounded git IPC (17). No
  automated shell test path (18).
- **Confirmed**: dead links (source), sub-frame navigations reach the guard (moot: no iframes), the single-instance
  socket, 34 `eprintln!`, the rescan race, unit `vault-changed`, the objc2 crates already locked, and the skip
  rationale for 12/13.
- **Still unmeasured (needs a packaged session)**: `typeof Notification` in WKWebView, hidden-window suspension
  timing, ⌘Z reaching JS, cold-start deep-link ordering, TCC behaviour for ad-hoc builds, and scan time on 5k notes.

## 9. Where to read first

1. `apps/web/tauri/navigation_plugin/src/lib.rs`: classify + route
2. `apps/web/src/lib/queries/trailing-refetch.ts`, then `subscribe-to-visible-cache-changes.ts`
3. `apps/web/src/lib/tauri/native-update-preparation.ts`, `native-updates.ts:49-79`
4. `apps/web/tauri/src-tauri/src/lib.rs`: `DeepLinkDelivery`, `flush_launch_deep_link`, plugin order, logging
5. `apps/web/src/lib/tauri/navigation.ts`: the effect flush (and why Cerebro must not copy it under StrictMode)
6. `apps/web/tauri/src-tauri/src/macos_notification_permission.rs`, `apps/web/src/lib/tauri/notification.ts`
7. `apps/web/src/lib/queries/undo.ts`
8. `apps/web/tauri/src-tauri/tauri.conf.json`, `capabilities/macos.json`, `apps/web/src/components/app/DesktopTitleBar.tsx`
9. `apps/web/tauri/src-tauri/src/desktop_update/desktop.rs`, `apps/web/tauri/desktop-release.json`
10. `apps/web/src/lib/graphql-cache/exchange/mutation-queue-runner.ts`, `crates/client/cache-core/src/queue.rs`,
    `apps/web/docs/graphql-cache-optimistic-enqueue-claim-plan.md`: reference only
11. `crates/client/cache-core/src/deps.rs`, `.../engine/watch_query.rs`: only if CLIENT-DESKTOP-10 fires
12. `crates/client/README.md`, `apps/web/docs/graphql-cache-testing.md`
