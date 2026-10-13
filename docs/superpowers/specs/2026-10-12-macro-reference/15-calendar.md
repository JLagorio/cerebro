# Macro reference — Calendar and scheduling

**Date:** 2026-10-12 · **Source:** `docs/examples/macro-main/` (vendored, gitignored). Every Macro path below is relative
to it; Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12):** Cerebro builds its own version, with Macro's code as the guide, never a 1:1 copy. Modes:
rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive, skip.
**Licences:** root `LICENSE.txt` (AGPL-3.0) covers `crates/calendar_events`, `crates/calendar_scheduling`, `crates/cal`,
`crates/graphql_calendar`, `services/calendar_service` (no Cargo.toml licence field; publish=false). `apps/web/LICENSE`
is "Copyright 2023 CoParse, Inc. All rights reserved": every frontend unit, pure TS utils included (`recurrence.ts`,
`availability.ts`), is behaviour-only. Permissive upstreams (registry-checked): `@fullcalendar/*` 6.1.21 MIT, crate
`ical` 0.11.0 Apache-2.0 (licence file; crates.io says "non-standard"), npm `rrule` 2.8.1 BSD-3-Clause, crate `rrule`
0.14.0 MIT OR Apache-2.0, `tauri-plugin-notification` 2.4.0 Apache-2.0 OR MIT, `objc2-event-kit` 0.3.2 Zlib OR
Apache-2.0 OR MIT.
**Evidence:** stages 1–2 read both trees; stage 3 ran a tsx engine probe (TZ=UTC), three tiny `claude -p` init probes,
crate-index and registry checks, and a demo-vault frontmatter scan. Not measured: packaged WKWebView `Notification`,
TCC persistence across ad-hoc rebuilds, EventKit all-day end semantics, a denied connector call. Stage 3 overrides 1–2.
**Baseline:** branch `m49-knowledge-integrity` (runtime `USER_VERSION=18`; `origin/main` is at 16).

---

## 1. What it is

- A **projection of Google Calendar**: Google is the write authority and the recurrence expander. Postgres holds a
  per-user event entity (owner + inbox + iCalUID), per-calendar provider copies, exceptions, and occurrences
  materialized 1 y back / 2 y forward (forward edge rounded up to the month).
- Sync = outbox → SQS → lease-fenced worker; syncToken feed, full snapshot on 410, per-calendar commit, push as hint +
  polling backstop. Writes go to Google first, then the normalized echo is persisted through the sync upsert path.
- Extras: popup reminders as Macro notifications, team sharing with coverage-aware availability, Cal.com-parity booking
  links. `crates/cal` is unrelated (Cal.com webhook → Meta Lead marketing analytics). Frontend: SolidJS + FullCalendar 6.

## 2. What users get

| Feature | UX details and shortcuts | Read |
| --- | --- | --- |
| Google Calendar per inbox | Settings → Calendar (`/app/settings/calendar`). Incremental consent (`calendar.events`, `calendar.calendarlist.readonly`). Account checkbox toggles child calendars (mixed state). Colour per account/calendar + "Reset to default"; visibility and colours are browser-local only. 3 consecutive isolated sync failures → settings badge (`CALENDAR_SYNC_FAILURE_BADGE_THRESHOLD`). Disconnect deletes Macro's copy, strips scopes, closes watches; Gmail keeps syncing. | `apps/docs/product/calendar.mdx`, `crates/calendar_events/src/domain/models.rs`, `crates/calendar_events/src/domain/mutations.rs`, `apps/web/src/features/calendar/components/connected-calendars.tsx` |
| Month / Week / Day grid | `/app/calendar/<month\|week\|day>`; `g r` opens. `d/w/m` pick view, `p\|k` prev, `n\|j` next, `t` today. 3-page pager, swipe on mobile; Day on phones, Week on desktop, last choice remembered. Click or drag to create, drag/resize to move, 30-min snap, now line, opens at 07:00, point events (start == end) as compact chips, merged working-location bars, OOO styling. Delayed skeletons; grid never blanks on fast paging. "Syncing your calendar…" banner; `RangeUnavailableBanner` outside the window. Sidebar: New (Event/Call/Reminder), mini calendar, Upcoming, Calendars, Team OOO. | `apps/web/src/features/calendar/components/CalendarGrid.tsx`, `apps/web/src/features/calendar/utils/time-grid-scroller.ts`, `apps/web/src/features/calendar/hooks/use-calendar-hotkeys.ts`, `apps/web/src/features/calendar-view/components/Header.tsx` |
| Composer with property pills | Inline title/description; pills for Calendar, Repeat (plain-English summary), Guests (optional flag), Conferencing (Meet or Macro call), Location, Notifications; OOO with auto-decline. Highlight follows the target calendar. New with no selection = next full hour, 1 h. Recurring edit asks "this event" vs "all"; recurrence lines sent only on series edits. Bottom sheet on touch, dialog on desktop; dirty draft asks before dismiss. | `apps/web/src/features/calendar/components/composer/EventForm.tsx`, `.../composer/event-form-model.ts`, `.../composer/RecurrenceBuilder.tsx`, `apps/web/src/features/calendar/hooks/use-event-editor.ts` |
| RSVP | Accept/decline/tentative, whole series or one occurrence; **no this-and-following**. Phone: glass sheet "This event"/"All events" → "Save response". | `apps/web/src/features/calendar-view/components/EventRsvpSection.tsx`, `crates/calendar_events/src/domain/ports.rs` |
| Reminders | Popup reminders: calendar defaults or ≤5 overrides, each ≤40,320 min; offsets 0/5/10/15/30 min, 1 h, 1 d, 1 w. Email reminders stored only for round-trip. Declined occurrences never alert. Home lists reminder rows. | `crates/calendar_events/src/domain/reminder_dispatch.rs`, `apps/web/src/features/calendar/utils/event-reminders.ts:9-20` |
| Copy availability | Free time as pasteable text, zone-labelled. Working hours default 09:00–18:00, weekends skipped; Today / This week / Next 7 / Next 14 days; slots <15 min dropped; "from now" rounded to 15 min; rechecked at copy. Empty ranges disabled with a focusable reason. Settings in localStorage `macro:pref:calendar:availability`. | `apps/web/src/features/calendar/availability/availability.ts`, `.../CopyAvailabilityDialog.tsx`, `.../zone-label.ts` |
| Events as entities | Global search (Kafka `macro.calendar`), @mention, copy as mention, preview resolved to the viewer's copy via iCalUID (requested occurrence → next upcoming → latest past). | `crates/calendar_events/src/domain/events.rs`, `apps/web/src/features/calendar-view/copy-event-mention.ts` |
| Upcoming events | Widening horizons 14/30/90/180/365/729 d until 5 found; ongoing events count (end > now); cancelled, declined, working-location dropped. | `apps/web/src/features/meetings/queries/upcoming-calendar-events.ts:20-22`, `apps/web/src/features/meetings/core/upcoming-calendar-events.ts:49-70` |
| Team sharing / overlay | busy_only (default) / all / none; read-only projections (no edit/RSVP/drag/mention); status "Not shared" / "Calendar unavailable" / "Event details" / "Busy blocks". Flag-gated. | `docs/calendar-team-sharing.md`, `crates/calendar_events/src/domain/team/models.rs`, `apps/web/src/features/calendar-team/` |
| Booking links | Personal/team event types (buffers, notice, horizon, limits, questions), weekly schedules + overrides in an IANA zone, collective / round-robin. Public `/app/book/:profile/:slug`, receipts `/app/booking/:id#token`; same request id on retry, never a second booking. Flag `enable-calendar-scheduling`. | `docs/CALENDAR_SCHEDULING_V1.md`, `crates/calendar_scheduling/src/domain/service.rs`, `apps/web/src/features/scheduling/primitives/booking-flow.ts` |
| Agent / MCP tools | ListCalendars, ListCalendarEvents (≤200 occurrences, ≤370 days, `truncated`, no total), CreateCalendarEvent (deferred → review composer), CreateConfirmedCalendarEvent (verbatim `userConfirmation`, unverified), Update (patch + rsvp, all\|this_event), Delete (all\|this_event\|this_and_following), GetTeamAvailability, booking-link tools. MCP host gets a plain Create (annotations additive, open_world). | `crates/calendar_events/src/inbound/toolset.rs`, `.../toolset/list_calendar_events.rs:20-21,97-100,125-130`, `.../toolset/create_confirmed_calendar_event.rs` |
| Email invite actions | ICS in email resolves to the viewer's synced copy for RSVP/join; ambiguous never guessed; missing copy = "not yet synced". | `crates/calendar_events/src/domain/invitations.rs` |

## 3. How it's built

**Architecture:** hexagonal Rust. `crates/calendar_events` = domain (models, ports, sync plan, mutation policy, change
log, reminders, team, availability) + feature-gated adapters (google/reqwest, postgres/sqlx, axum inbound, ai_tools,
SQS dispatch, notify, mutation-client). `services/calendar_service` = write authority + sync host (webhook, mutation
routes, outbox/scheduler loop, SQS workers, scheduling recovery). `services/document_storage_service` = read routes,
GraphQL, reminder dispatch worker, Cal.com webhook; forwards mutations over HTTP. Web reads REST or a GraphQL cache with
watermark delta sync and an optimistic durable mutation queue.

| unit | path | role | LOC |
| --- | --- | --- | --- |
| Domain models | `crates/calendar_events/src/domain/models.rs` | `EventTime{Timed,AllDay}`, entity vs source content, overrides, occurrences, `OccurrenceRange`, `EventReminders`, `GoogleSyncPlan`, uuid-v5 `creation_provider_id` | 1775 |
| Ports | `crates/calendar_events/src/domain/ports.rs` | Provider/repo/token/notifier/queue traits; scope enums omit this-and-following for update + RSVP; `GoogleProviderErrorKind` | 967 |
| Sync orchestration | `crates/calendar_events/src/domain/service.rs` | Lease-fenced backfill; per calendar plan → `validate_upsert` whole batch → upsert → commit → renew watch; scheduler, reaper, reauth | 1006 |
| Mutation policy | `crates/calendar_events/src/domain/mutations.rs` | Provider-first create/update/delete/RSVP, persist echo; `ensure_organizer_attendee`, `preserve_retained_attendee_state` | 845 |
| Change log | `crates/calendar_events/src/domain/changes.rs` | Per-link seq + watermark; 500 events / 5000 occurrences per page; 30-day retention → reset | 557 |
| Reminder dispatch | `crates/calendar_events/src/domain/reminder_dispatch.rs` | Minutely sweep (page 500); claim → notify → complete; `RETRY_AFTER` 5 min | 178 |
| Invitations | `crates/calendar_events/src/domain/invitations.rs` | Email ICS → viewer's copy + RSVP capability; never creates data | 275 |
| Team sharing | `crates/calendar_events/src/domain/team/` | all\|busy_only\|none; disjoint Busy/Details shapes; revision-checked cursors | 743 |
| Coverage availability | `crates/calendar_events/src/domain/team_availability.rs` | Pure busy merge with typed unknown reasons; free windows only under complete coverage | 352 |
| Google adapter | `crates/calendar_events/src/outbound/google.rs` | list/instances/iCalUID/watch/insert/patch/delete; change-feed classify, `refresh_series`, `extend_tail`, error taxonomy, quota gate, `sendUpdates=all` | 2551 |
| Postgres repo | `crates/calendar_events/src/outbound/pg.rs` | Advisory lock per (inbox, iCalUID); identical-payload short-circuit; per-copy sequence guard; projections; occurrence + firing rebuild; change-log append | 5459 |
| AI toolset | `crates/calendar_events/src/inbound/toolset.rs` (+ `toolset/*`, `team_toolset.rs`) | `calendar_toolset` (deferred Create + CreateConfirmed) vs `mcp_toolset` (plain Create) | 1697 + 136 |
| HTTP routers | `crates/calendar_events/src/inbound/` | `/calendar-events*`, `/calendars`, `/events`, `/events/{id}/rsvp`, `/team-sharing`, `/availability-calendars` | 1661 |
| Scheduling domain | `crates/calendar_scheduling/src/domain/` | Profile/schedules/event types; DST-aware `slots_for_date` (`availability.rs`, 657 with models); booking lifecycle; `recover_once`; `PublicBudget` | 2099 |
| Scheduling adapters | `crates/calendar_scheduling/src/outbound/macro_services.rs`, `outbound/postgres.rs`, `inbound/router.rs` | Fail-closed busy; EXCLUDE reservations; public routes; quote-gated tools | 1328 |
| Cal.com webhook | `crates/cal/` | HMAC `X-Cal-Signature-256`; BOOKING_CREATED → Meta Lead. Marketing only | 589 |
| GraphQL | `crates/graphql_calendar/` | async-graphql; `calendarOccurrences` reads the watermark before the rows | 2079 |
| Service host | `services/calendar_service/src/` | 5 s outbox loop, SQS workers, constant-time watch token, Redis limiter (300/inbox), 15 s recovery (≤25 ops) | 1790 |
| Grid | `apps/web/src/features/calendar/components/CalendarGrid.tsx` | FullCalendar wiring (`:281-285` selectMinDistance 0, snap 00:30); leans on timegrid (1,145) + interaction (2,126) plugins | 437 |
| Grid helpers | `apps/web/src/features/calendar/utils/calendar-date.ts`, `event-interaction.ts`, `time-grid-scroller.ts` | Midnight-end + exclusive ends (`calendar-date.ts:69-71`); no-drag rules (`event-interaction.ts:35-44`); 07:00 open (`time-grid-scroller.ts:52`) | 84 + 75 + 80 |
| Composer | `apps/web/src/features/calendar/components/composer/` | EventForm, pills, recurrence builder, form model; shared with chat draft composer | ~3000 |
| Recurrence utils | `apps/web/src/features/calendar/utils/recurrence.ts` | RRULE/RDATE/EXDATE parse (FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, COUNT, UNTIL `:118-170`), describe, build, presets. **No expansion** | 690 |
| Copy availability | `apps/web/src/features/calendar/availability/` | Free-slot derivation, text, settings | 874 |
| View shell | `apps/web/src/features/calendar-view/` | Workspace, header, pager, sidebar, popover, search, URL state (`calendar-url.ts`, `calendar-navigation.ts`) | 5421 |
| Query layer | `apps/web/src/lib/queries/calendar/` | REST paging + dedupe; `CalendarSyncController` (250 ms debounce, ≤50 pages); optimistic patch + rollback | 3688 |
| Chat draft composer | `apps/web/src/lib/core/component/AI/component/tool/calendar/` | EventForm over a pending user tool; `UserToolReviewSink` | 2264 |
| Deferred user tool | `crates/ai_toolset/src/toolset/tool_object/user_tool.rs` | Agent call → `PendingUserExecution`; user executes via `/tools/call/{id}` | — |
| Team UI / Scheduling UI / block host / infra | `apps/web/src/features/calendar-team/`, `features/scheduling/`, `features/block-calendar/`, `infra/stacks/calendar-service/` | Overlay; booking admin + public pages; retired block host; Pulumi Fargate + SQS + Redis | 771 / 5934 / 244 / 653 |

**Data model** (migrations in `crates/macro_db_client/migrations/` unless noted):

| Entity | Store | Key fields | Path |
| --- | --- | --- | --- |
| `calendar_accounts` | Postgres | one per email link; `sync_status` pending\|syncing\|ready\|error\|reauth_required\|disabled | `20260725014930_calendar_entities.sql` |
| `calendars` | Postgres | (account, provider_calendar_id); time_zone, access_role, is_primary; sync_token; watch channel + `watch_unsupported_at`; materialized range; `default_reminders`; per-calendar error | same + `20260810213910_*`, `20260908191815_*`, `20260923032706_*` |
| `calendar_events` (entity) | Postgres | unique (owner, source_link, ical_uid); canonical-copy content; timed XOR all-day (relaxed for point events); `recurrence_lines text[]`; sequence; reminders | same + `20261008012008_calendar_allow_google_point_events.sql` |
| `calendar_event_sources` | Postgres | unique (account, calendar, provider_event_id); etag; raw + normalized payload; per-copy content, read-only flag, verified access role | `20260904164106_*`, `20261007182532_*` |
| `calendar_event_attendees` / `_overrides` | Postgres | (event, email) response_status; (event, recurrence_id) replacement time/title/status + per-instance attendees | `20260725014930_*`, `20260810154320_*` |
| `calendar_event_occurrences` | Postgres | (event, occurrence_key = RFC 3339 start or date); generated `tstzrange`/`daterange` | `20260725014930_*` |
| reminder `_firings` / `_deliveries` | Postgres | firings (event, occ, minutes_before) + fire_at, rebuilt with occurrences; deliveries unique (…, fire_at), **not** FK'd → survive rebuilds as exactly-once claims | `20260810213910_calendar_event_reminders.sql` |
| backfill jobs + outbox | Postgres + SQS | (link, kind, grant_version) + lease; outbox `FOR UPDATE SKIP LOCKED` | `20260725014930_*`, `services/calendar_service/src/calendar_outbox.rs` |
| change counters + log | Postgres | per-link seq; kinds 1–4; 30-day retention | `20261006230258_calendar_change_log.sql` |
| team sharing + availability prefs | Postgres | missing row = busy_only; per (user, calendar) `contributes_to_availability` | `20261007182215_calendar_team_sharing.sql` |
| scheduling profile / booking / host_claim / budget | Postgres | profile revision CAS; booking `request_id` unique; `tstzmultirange` EXCLUDE USING gist; 120/min + 30/h, fail closed | `20260918164303_calendar_scheduling.sql`, `20260918175703_scheduling_recovery.sql` |
| client prefs | localStorage | visibility, colours, period, working hours | `apps/web/src/features/calendar/utils/preferences.ts`, `.../availability/settings.ts` |

**Key flows:**

1. **Grant → sync.** (1) Grant bumps `grant_version`, inserts job + outbox row. (2) 5 s loop runs scheduler/reaper,
   drains outbox to SQS. (3) Worker claims lease → `GoogleCalendarBackfillCoordinator::run`. (4) `calendarList`; per
   calendar: upsert, skip system calendars synced <24 h, pick FullSnapshot / ExtendTail / Incremental. (5)
   `events.list` with syncToken (showDeleted); 410 → retry without token; snapshot = unexpanded list + `singleEvents`
   over [now−365 d, month-ceil(now+730 d)]; incremental refreshes changed series via iCalUID + `/instances`. (6)
   Validate whole batch; one bad event fails that calendar (badge after 3); ReauthRequired fails the account. (7)
   `upsert_event`: lock, short-circuit, sequence guard, projections, firings, change log. (8) Commit token/range/
   tombstones per calendar; renew watch; reconcile list. (9) Kafka → gateway poke → client delta.
   (`crates/calendar_events/src/domain/service.rs`, `crates/calendar_events/src/outbound/google.rs`,
   `crates/calendar_events/src/outbound/pg.rs`)
2. **Push → resync.** Google POSTs `/notifications`; constant-time token check (403 on mismatch); "sync" acked;
   `handle_watch_notification` re-arms the job; unmatched → 200 because polling is the backstop.
   (`services/calendar_service/src/api/calendar_watch.rs`)
3. **User edit / drag.** (1) Drop or composer save → `use-event-editor` (all\|this_event). (2) Optimistic patch +
   rollback. (3) PATCH `/events/{id}`. (4) Validate, reject read-only copies, keep attendee RSVPs. (5) Google patch or
   instance patch; OccurrenceGone / SeriesGone handled. (6) `persist_echo` via `upsert_event`. (7) Change log, Kafka,
   refresh. (`crates/calendar_events/src/domain/mutations.rs`, `apps/web/src/lib/queries/calendar/mutations.ts`)
4. **Agent create.** Chat: CreateCalendarEvent → `PendingUserExecution` → `CalendarDraftComposer` → execute/reject →
   `create_event` (primary unless `calendarId`; organizer added except OOO; insert; echo). Threads: prose draft → user
   reply → CreateConfirmed with verbatim quote (blank refused, never verified). MCP: plain Create.
   (`crates/calendar_events/src/inbound/toolset/create_confirmed_calendar_event.rs`, `crates/ai_toolset/src/toolset/tool_object/user_tool.rs`)
5. **Public booking.** (1) Slots spend the 120/min budget → `slots_for_date` (IANA windows, DST-ambiguous starts
   skipped; host busy fails closed on not-Ready/errored/truncated; all-day busy padded −14 h..+12 h). (2) Book: replayed
   `request_id` returns the existing booking; slot re-verified; `reserve()` EXCLUDE claim (backup host on conflict).
   (3) Provider create with uuid-v5 id → confirmed. (4) Failure keeps the reservation; recovery every 15 s (5-min lease,
   backoff 5 min → 1 h). (`crates/calendar_scheduling/src/domain/service.rs`, `.../domain/recovery.rs`)
6. **GetTeamAvailability.** UTC [start, end), ≤100 users; coverage = sync <15 min + verified role + current
   normalization; ≤20,000 occurrences; `calculate` keeps personally-busy copies, resolves all-day in the calendar zone,
   flags `ConflictingCopies`; `freeWindows` only when complete, else `unknown_reasons`.
   (`crates/calendar_events/src/domain/team_availability.rs`)

## 4. Ideas worth stealing (ranked)

1. **Coverage-aware free time with typed unknown reasons** (Hidden, Unavailable, Truncated, MissingTimeZone,
   InvalidTimeZone, InvalidInterval, ConflictingCopies). It is "absent is never zero / unavailable is never empty",
   already coded. `crates/calendar_events/src/domain/team_availability.rs`
2. **Whole-batch reject + per-calendar commit.** The cursor never passes a skipped event, so "complete" stays true. Model
   for any external window Cerebro stores. `crates/calendar_events/src/domain/service.rs` (`validate_upsert`)
3. **Reminder identity includes `fire_at`; claims live outside the rebuildable table.** Moved event re-alerts; rebuild
   never re-fires. `crates/macro_db_client/migrations/20260810213910_calendar_event_reminders.sql`,
   `crates/calendar_events/src/domain/reminder_dispatch.rs`
4. **Point events preserved** (start == end, `[start, end)`, never busy). Never invent a duration.
   `crates/calendar_events/src/domain/models.rs`, `.../20261008012008_calendar_allow_google_point_events.sql`
5. **Grid edge rules:** midnight end does not occupy the next day; multi-day timed spans go to the all-day row;
   recurring/point/read-only/cancelled/team events do not drag. `apps/web/src/features/calendar/utils/calendar-date.ts`,
   `apps/web/src/features/calendar/utils/event-interaction.ts:35-44`
6. **Disjoint Busy/Details shapes**, not blanked fields: a later field cannot leak through busy-only.
   `crates/calendar_events/src/domain/team/models.rs`
7. **Entity vs provider copies.** In Cerebro terms: one page per meeting, provider snapshots as operational rows.
   `crates/calendar_events/src/domain/models.rs`, `.../20260904164106_calendar_event_source_content.sql`
8. **Tool descriptions carry the guardrails** (narrow windows, report sync status, recurrenceId for scoped edits,
   attendee list replaces all, never infer free time). Guide for Cerebro's own wording.
   `crates/calendar_events/src/inbound/toolset/list_calendar_events.rs`, `.../update_calendar_event.rs`, `.../team_toolset.rs`
9. **Upcoming = widening horizons, ongoing counts (end > now).** `apps/web/src/features/meetings/core/upcoming-calendar-events.ts`
10. **Copy availability as text** — booking-link value without a public page.
    `apps/web/src/features/calendar/availability/availability.ts`
11. **Idempotent create via uuid-v5 provider id** — a retry cannot double-invite. `crates/calendar_events/src/domain/models.rs`
12. **No this-and-following for update/RSVP** — emulating it is two non-atomic writes that re-invite guests. For vault
    records it is a product choice, not a constraint. `crates/calendar_events/src/domain/ports.rs`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | value | note |
| --- | --- | --- | --- |
| Google sync engine (OAuth, syncToken, push, provider-first writes) | different-by-design | medium | No credential enters the app (AGENTS.md, M34.5). Substitutes CALENDAR-9 (EventKit), CALENDAR-10 (connector); engine = CALENDAR-13 skip. |
| User's real calendar beside vault records | absent | high | The core of Macro's calendar. CALENDAR-9/10, gated on R14. |
| Day/Week hours grid | absent | high | Times stored since M16.14, dropped by `spanOf` (`src/engine/schedule.ts:68-81`). CALENDAR-4/5. |
| Month grid, multi-day events | already-better | low | Lane packing, `+N more`, undated tray, keyboard moves (`src/views/CalendarView.tsx`, 517 LOC). |
| Timeline / Gantt | already-better | low | Macro has neither (`src/views/TimelineView.tsx`, `GanttView.tsx`). |
| Click / drag slot to create | partial (**buggy**) | high | Day `+` writes a bare string into daterange fields; `createItem` never validates (`src/stores/vaultStore.ts:281-291`). No drag-create; embeds lack create-on-day. CALENDAR-1/5. |
| ListCalendarEvents tool | absent | high | 17 base tools (`src-tauri/src/mcp.rs:740-916`), none dated; `search_notes` is BM25. CALENDAR-3. |
| Reminders → notifications, exactly-once | partial | medium | Body chips only; days-only offsets; localStorage fired set keyed `path#line@at` (global, not vault-scoped); fires on `- [x]`; no notification plugin. CALENDAR-6. |
| Durable fire claims | solid (reusable) | — | `src-tauri/src/runtime/job_ledger.rs` (V16 CHECK pins three ledgers), `catchup.rs`. |
| Recurrence | absent | medium | No RRULE anywhere; agent schedule grammar only (`src/engine/skills.ts`). CALENDAR-7. |
| Zoned instants | partial | medium | Floating local only; `2026-07-28T09:20:00Z` read **four** ways. CALENDAR-2. |
| Upcoming / one view of everything | absent | medium | Home lists checklist chips only (`src/pages/HomePage.tsx`). CALENDAR-12. Vault-wide Calendar destination = DOMAIN:shell call. |
| ICS parsing | absent | medium | Macro uses `ical` for email invites only. CALENDAR-8. |
| Composer with pills | different-by-design | low | An event is a page: property panel + body. |
| Agent create/update/delete with confirmation | different-by-design | low | Vault writes via `create_note`/`update_frontmatter`; external writes stay with the user's connector. |
| Copy availability | absent | low | Little busy data; connector has `suggest_time`. CALENDAR-11. |
| Events as entities | already-better | low | Pages are searchable, wikilinkable, knowledge-anchorable. |
| Hotkeys, pager, remembered view, URL position | partial | low | Prev/next/Today exist. Span persisted from settings only; ViewCanvas doesn't pass `onPresentationChange` (`src/views/ViewCanvas.tsx:193-203`). Anchor resets on remount (`CalendarView.tsx:76`). Keymap = DOMAIN:shell (D11). |
| Team sharing, booking, RSVP, invites, Cal.com | different-by-design | low | Multi-user, public endpoint or email surface. CALENDAR-15 skip. |
| Change log + watermark delta | different-by-design | low | One process with a vault watcher. |

## 6. Port candidates

Sequence: 1 → 2 → 3 → 4 → 6 → 5 → 12 → 7 → 8 → 9 → 10 (only if EventKit declined) → 11.

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CALENDAR-1 | Create-on-day writes by field kind | rebuild | inspire | S | high | `apps/web/src/features/calendar/components/composer/event-form-model.ts`, `.../components/CalendarGrid.tsx` | `src/pages/TypePage.tsx`, `src/pages/ListPage.tsx`, `src/views/QuickAdd.tsx`, `src/engine/schedule.ts`, `src/engine/dates.ts`, `src/views/DatabaseBlockView.tsx`, `src/views/CalendarView.test.tsx`, `e2e/collections.spec.ts` | — (= roadmap M53.16) |
| CALENDAR-2 | One date grammar for Rust + TS, incl. instants and the writer | rebuild | adapt | M | high | `crates/calendar_events/src/domain/models.rs`, `apps/web/src/features/calendar/utils/calendar-date.ts`, `.../20261008012008_calendar_allow_google_point_events.sql` | `shared/calendar/dates.v1.json` + `.sha256` + `README.md`, `src-tauri/src/vault/dates.rs`, `src-tauri/src/vault/mod.rs`, `src-tauri/src/mcp.rs` (cache_source writer), `src/engine/dates.ts`, `src/engine/properties.ts`, `src/engine/schedule.ts` | DOMAIN:data (DATA-9 references it), D3 |
| CALENDAR-3 | `list_agenda` read-only tool on loopback MCP | rebuild | adapt | M (L if DATA-9 lags) | high | `crates/calendar_events/src/inbound/toolset/list_calendar_events.rs`, `apps/docs/AI/mcp/tools/list-calendar-events.mdx`, `crates/calendar_events/src/domain/team_availability.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/vault/dates.rs`, `src/engine/tools.ts`, `src/engine/tools.test.ts`, `src/agent/systemPrompt.ts` | CALENDAR-2, DATA-9, D3 |
| CALENDAR-4 | Hours grid (Day; Week with hours), read-only | rebuild | adapt | M | high | `apps/web/src/features/calendar/utils/calendar-date.ts`, `.../utils/time-grid-scroller.ts`, `.../utils/event-interaction.ts`, `.../components/CalendarGrid.tsx`, `apps/web/src/features/calendar-view/components/Header.tsx` | `src/engine/schedule.ts`, `src/views/CalendarTimeGrid.tsx` (new), `src/views/CalendarView.tsx`, `src/views/ViewCanvas.tsx`, `src/views/viewKinds.ts`, `src/engine/types.ts`, `src/engine/views.ts`, `src/views/ViewSettingsPanel.tsx`, `e2e/collections.spec.ts` | CALENDAR-2 |
| CALENDAR-5 | Hours editing: minute move/resize, drag-to-create, keyboard snaps | rebuild | adapt | L | high | `apps/web/src/features/calendar/components/CalendarGrid.tsx:281-285`, `.../utils/event-interaction.ts`, `.../composer/event-form-model.ts:62-66` | `src/views/useTimeDrag.ts`, `src/hooks/useDragGesture.ts`, `src/views/CalendarTimeGrid.tsx`, `src/views/QuickAdd.tsx`, `src/pages/TypePage.tsx`, `src/pages/ListPage.tsx`, `e2e/collections.spec.ts` | CALENDAR-4, CALENDAR-1 |
| CALENDAR-6 | Calendar slice of durable reminders | rebuild | adapt | **S** | medium | `crates/calendar_events/src/domain/reminder_dispatch.rs`, `.../20260810213910_calendar_event_reminders.sql`, `apps/web/src/features/calendar/utils/event-reminders.ts` | `src/engine/reminders.ts`, `src/engine/dates.ts`, `src/hooks/useReminders.ts`, `src/detail/FieldEditor.tsx`, `src/components/ui/DatePicker.tsx` | M64.3 (AUTOMATION-8 + COMMS-5 claim step), COMMS-6 / CLIENT-DESKTOP-6 (OS delivery), CLIENT-DESKTOP-16 (vault-scoped keys) |
| CALENDAR-7 | Recurring records (7a TS; 7b Rust expander + vectors) | rebuild | adapt | **XL** | medium | `apps/web/src/features/calendar/utils/recurrence.ts`, `.../composer/RecurrenceBuilder.tsx`, `.../hooks/use-event-editor.ts`, `crates/calendar_events/src/domain/ports.rs` | `src/engine/recurrence.ts`, `shared/calendar/recurrence.v1.json`, `src-tauri/src/vault/recurrence.rs`, `src/engine/types.ts`, `src/engine/properties.ts`, `src/engine/schedule.ts`, `src/views/CalendarView.tsx`, `src/views/CalendarTimeGrid.tsx`, `src/detail/FieldEditor.tsx`, `src/lib/mockIpc.ts` | CALENDAR-2, CALENDAR-4, DOMAIN:data; 7b on D3 |
| CALENDAR-8 | Import `.ics` into pages | adopt-upstream (`ical` 0.11) + rebuild normalizer | adapt | M with DATA-5, else L | medium | `crates/email/src/domain/calendar_invitation_parser.rs`, `crates/email/Cargo.toml:46` | `src-tauri/src/vault/ics.rs`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/pages/TypePage.tsx`, `.gitattributes` | CALENDAR-2, CALENDAR-7 (or "repeats, not expanded" marker), DOMAIN:integrations (D15), DATA-5 |
| CALENDAR-9 | External overlay (operational, read-only) via macOS EventKit | rebuild | adapt | XL | high | `crates/calendar_events/src/domain/models.rs`, `.../domain/service.rs`, `.../domain/team_availability.rs`, `.../domain/team/models.rs`, `apps/web/src/features/calendar-view/components/SyncStatus.tsx` | `src-tauri/src/runtime/calendar.rs`, `src-tauri/src/runtime/schema.rs`, `src-tauri/src/calendar/eventkit.rs`, `src-tauri/Cargo.toml`, `src-tauri/Info.plist`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/views/CalendarView.tsx`, `src/views/CalendarTimeGrid.tsx`, `src-tauri/src/mcp.rs` | CALENDAR-2/3/4, DOMAIN:client-desktop, DOMAIN:integrations, R14 + owner ruling |
| CALENDAR-10 | Connector-fed overlay window (user's Google Calendar MCP) | rebuild | adapt | L | low | `crates/calendar_events/src/domain/service.rs`, `.../inbound/toolset/list_calendar_events.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/runtime/calendar.rs`, `src/agent/systemPrompt.ts`, `src/engine/tools.ts`, `src-tauri/src/agent/mod.rs` | CALENDAR-9, DOMAIN:mcp (`--disallowedTools`), DOMAIN:integrations, R14 |
| CALENDAR-11 | Copy availability with honest coverage | rebuild | adapt | M | low | `apps/web/src/features/calendar/availability/availability.ts`, `.../CopyAvailabilityDialog.tsx`, `.../zone-label.ts`, `crates/calendar_events/src/domain/team_availability.rs`, `crates/calendar_scheduling/src/domain/availability.rs` | `src/engine/availability.ts`, `src/views/CopyAvailabilityDialog.tsx`, `src/views/CalendarView.tsx` | CALENDAR-9, CALENDAR-4 |
| CALENDAR-12 | "Coming up" across every dated database on Home | rebuild | inspire | S | medium | `apps/web/src/features/meetings/queries/upcoming-calendar-events.ts`, `apps/web/src/features/meetings/core/upcoming-calendar-events.ts` | `src/pages/HomePage.tsx`, `src/engine/schedule.ts`, `src/engine/schedule.test.ts` | CALENDAR-2, DOMAIN:product (D9) |
| CALENDAR-13 | Cerebro-owned Google OAuth sync engine | skip | — | XL | medium | `crates/calendar_events/src/outbound/google.rs` | — | Owner reversal of M34.5 + R14 pack |
| CALENDAR-14 | Adopt FullCalendar (`@fullcalendar/react`) | skip | — | M | low | `apps/web/src/features/calendar/components/CalendarGrid.tsx` | — | Reopen only if CALENDAR-5 fails on `useTimeDrag` |
| CALENDAR-15 | Booking links, team sharing/availability, RSVP, invite actions, Cal.com | skip | — | XL | low | `crates/calendar_scheduling/src/domain/service.rs`, `crates/calendar_events/src/domain/team/models.rs` | — | Hosted relay + DOMAIN:email |

Candidate notes (all):

- **CALENDAR-6 re-scoped to S.** Claim storage + identity live in M64.3 with AUTOMATION-8 and COMMS-5 (roadmap:524);
  OS delivery with COMMS-6/CLIENT-DESKTOP-6; vault-scoped keys with CLIENT-DESKTOP-16. Calendar keeps: type-level
  remind defaults on date fields; minute/hour offsets for timed values (`remind:10m` parses to null today;
  `src/engine/dates.ts:24,93`); no reminder on a checked task or done-status record (gate by capability); burst
  coalescing on relaunch; drop the "(9:00 AM)" labels for timed values (`dates.ts:208-214`). Comment kills:
  `useReminders.ts:62-66`, `reminders.ts:20-21`, `dates.ts:218-222`, `DatePicker.tsx:368-372`. Needs a
  `backgroundThrottling` decision (unset in `tauri.conf.json`).
- **CALENDAR-7 split.** 7a: TS parse/describe/build/expand, new FieldKind (~8 TS sites), "This event" detaches the
  occurrence into its own page (EXDATE on series + relation back; fixtures use `entry.relationships`). 7b: Rust
  expander + `recurrence.v1.json`, needed once agenda or reminders cover recurring records. Macro's guide has zero
  expansion code (690 + 253 + 440 LOC of parse/describe/build/scope). Unknown parts (e.g. BYSETPOS) render once with
  "repeat rule not understood". 370-day bound + occurrence cap, truncation stated.
- **CALENDAR-8.** Rechoose caps (Macro's 512 KiB / 32 components are email-invite caps,
  `calendar_invitation_parser.rs:12-14`). Count, never convert, unknown TZIDs and DST-ambiguous times; count ical parse
  errors (Macro `.flatten()`s them, `:25-27`). All-day DTEND exclusive → inclusive end −1 day. UID(+RECURRENCE-ID) as
  bookkeeping frontmatter → re-import updates. Dry-run preview with skip counts by reason. Regenerate Windows zones from
  CLDR `windowsZones.xml`; never copy Macro's AGPL `windows_zones.rs`. CRLF fixtures as `\r\n` escapes or a `*.ics`
  `.gitattributes` rule. cargo-deny clarify entry for ical's licence file.
- **CALENDAR-9.** Window −30 d…+90 d; per-calendar validate-then-commit, failures keep prior rows marked stale; rows in
  runtime.db only; denied/not-determined/restricted → `section-unavailable` with reason; Busy-only by default, Details
  opt-in; idempotent "Make a page" into a database picked by capability; disconnect deletes the cache. Runtime branch
  `requestFullAccessToEvents` (14+) vs `requestAccessToEntityType` — no floor conflict. Both `NSCalendarsUsageDescription`
  and `NSCalendarsFullAccessUsageDescription` in `src-tauri/Info.plist`. `EKEventStoreChangedNotification` = refresh
  hint (Macro's push-hint analogue). Spike must measure TCC re-prompt and the all-day end convention.
- **CALENDAR-10.** Works only in attended non-strict runs with no `connectors.json` plus an explicit grant (strict drops
  claude.ai connectors; unattended runs are strict, `connectors.rs:154`). Add `--disallowedTools` for connector write
  tools: `--setting-sources user` imports global allow rules. Whole-window rejection names an operational code
  (`schema_invalid` or `malformed_arguments`). Change both prompt sites: `systemPrompt.ts:51`, `mcp.rs:889` ("ALWAYS").
- **CALENDAR-11.** Macro excludes all-day events from busy (`availability.ts:160-170`) and nearly every vault date is
  all-day, so without CALENDAR-9 the busy set is ~empty.
- **CALENDAR-12.** Define the ongoing-span rule (Macro: end > now). Membership needs a field-level opt-in or a
  bookkeeping-field exclusion, else Source `fetched_at` lists. Silent when empty, no count/badge; failed read =
  `section-unavailable`. Regenerate e2e from demo-vault: ops-5 (window starts 07-28) and phx-421 (07-28T09:20Z) precede
  the 07-29 item; ongoing lnc-2 (07-20..07-31) sorts first under end > now.

**Top three:**

**CALENDAR-1 — create-on-day by kind (S, live defect).**
- Day `+` passes `{[dateField]: day}` (`src/pages/TypePage.tsx:215-219`, `src/pages/ListPage.tsx:127-131`);
  `validateValue(daterange, '2026-08-05')` → "window must be a start/end range". Recorded M16.23, still open.
- One helper through `dateKindOf` + `serializeDateProperty` (`schedule.ts:548-553`, `dates.ts:290-296`): daterange →
  `{start, end: null}`, date → scalar, undeclared → `dateKindOf`. TypePage, ListPage and the page embed share it (embeds
  gain create-on-day — a new affordance).
- e2e: Work item calendar (`window`) → day `+` → `__cerebroMockFs` holds a window mapping. MCP writes share the defect
  class (`mcp.rs:2649-2671`) — that belongs to DATA-9.

**CALENDAR-2 — one date grammar (M, unblocks 3/4/7/8/9/12).**
- Probe of `2026-07-28T09:20:00Z`: `parseDateProperty` → local 09:20; `coerceValueToKind(date)` → date only;
  `validateValue` → error; `inferKindFromValue` → text. Cerebro's own Rust writes that value into a declared `date`
  field (`mcp.rs:2845-2847, 2916`; `demo-vault/types/source.md:9`) and `stale_after` as a UTC date (`:2919-2923`).
- `shared/calendar/dates.v1.json` cases (scalar; date+HH:MM with space/T; range with null/missing/backwards end; Z and
  ±HH:MM; `{{date}}`; garbage) pin `{date, time, instant, valid}`; replayed by vitest and cargo; sha256 per the
  **freshness.v1** precedent. Pins point events and the midnight-end rule. Fix the writer or admit instants.
- Tests inject a zone (vitest/cargo have no TZ pin; precedent `src/knowledge/KnowledgePanel.test.tsx:101-116`).
  DATA-9's `field-kinds.v1.json` references this file, not restates it. Comment kills: `schedule.ts:21-24`,
  `useTimeDrag.ts:22-23`, `properties.ts:688-696`, `dates.ts:241-245`. Reverses M16.14's "Z degrades to date" — cite it.

**CALENDAR-3 — `list_agenda` (M if DATA-9's Rust schema reader lands first, else L).**
- Rows `{path, title, type, field, start, end, all_day, point}` for every record with a declared date/daterange field
  (capability, not type) overlapping a half-open local window, soonest first; ≤200 with `truncated` + `total` (total is
  Cerebro's addition); `templates/` excluded; undated, unparseable and read-scope-withheld (M34.4) **counted**; optional
  type filter; never claims free time; writes nothing.
- Acceptance over demo-vault `[2026-07-20, 2026-08-03)`: ~39 rows (4 kickoffs 07-24, 12 due, 2 decided, 1 `fetched_at`,
  20 windows), zone injected for the instant. Description states untyped date keys and body 📅 chips are not listed.
- Review call: >370-day refusal as plain `isError` (base read tools do, `mcp.rs:2016, 2151`) or `malformed_arguments`
  (operational in `policy.v3.json`).

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| Server-held Google refresh tokens, reqwest client, provider-first writes (`sendUpdates=all`) | No API key / credential enters the app (AGENTS.md, M34.5) | Skip the engine (CALENDAR-13). Read via OS-held accounts (EventKit, CALENDAR-9) or the user's connector (CALENDAR-10). Cerebro never writes to a provider; connector write tools explicitly disallowed. |
| Provider copies in Postgres as system of record | Vault is truth; two records, two destinies | External snapshots = runtime.db operational rows (never git, never ledger); a page only via explicit "Make a page". |
| Always-on SQS/EventBridge sweep; push webhooks | App-lifetime execution, launch catch-up, late fires say late (M34 D3) | Tick + overlay refresh while open; misses shown once as late, bounded by `catchup.rs` clean_exact / heartbeat_lower_bound. No daemon. |
| Copy availability gates only on syncing/load failure; missing data read as free | Absent is never zero; unavailable is never empty | Carry `team_availability`'s coverage reasons; no free text unless every declared source is complete (CALENDAR-11). |
| Deferred `PendingUserExecution`; CreateConfirmed on an unverified quote | Proposal channels return typed applied\|queued\|rejected | No Cerebro external-write tool. Vault writes use existing writers; any future gate is a typed proposal card. |
| FullCalendar's own DnD, selection, CSS | One keyboard-operable drag primitive (M16.2, M46.2); DS tokens | Hand-build on `useTimeDrag`/`useDragGesture` (CALENDAR-5); CALENDAR-14 skip. |
| Date/recurrence logic twin in TS and Rust, no fixtures | Twin rule = shared artifact + goldens (`shared/policy/README.md`) | `shared/calendar/dates.v1.json` (CALENDAR-2), `recurrence.v1.json` if Rust expands (CALENDAR-7b). Needs D3. |
| Dedicated `calendar_events` entity type | No type special-casing; a schema belongs to one database (M47 D3) | Gate on date/daterange/recurrence kinds; import/overlay targets picked by capability; identity in bookkeeping keys (cache_source precedent). |
| localStorage for fired reminders and prefs | Durable fire state in runtime.db (M34.2); localStorage = per-viewer conveniences | Claims move with M64.3 (one-time import of `cerebro.firedReminders`); working hours and visibility may stay local. |
| Zoned UTC instants converted by the grid | Vault times are floating local, never routed through UTC (M16.14) | Vault values stay floating; Z/offset instants and overlay rows convert explicitly and are labelled (CALENDAR-2). |
| All-day ends exclusive (RFC 5545) | Daterange ends inclusive (`schedule.ts` `dayCount`) | Convert at the boundary (exclusive − 1 day); pin per source in vectors; EventKit convention measured in the spike. |
| ICS normalizer silently drops malformed parts / UID-less events | Absent is never zero | Import reports skipped counts by reason after a dry run (CALENDAR-8). |
| Bare-letter hotkeys (`d/w/m/t`, `p/k`, `n/j`) | Every shortcut is ⌘ + editing guard (`src/App.tsx`) | Defer to DOMAIN:shell keymap (D11); if adopted, calendar-focus scope + editing guard. |
| Raw CRLF in ICS fixtures | No raw control bytes (AGENTS.md, `.gitattributes`) | `\r\n` escapes or a `*.ics` `.gitattributes` rule. |

## 8. Verification notes (stage 3)

- **Refuted — plugin needs Tauri ≥2.12.** `tauri-plugin-notification` 2.4.0 requires `tauri ^2.10` (Apache-2.0 OR MIT,
  published 2026-08-31); only 2.5.0+ need ^2.12. Pin `=2.4.0` against tauri 2.11.5. D12 is not a notification blocker.
- **Refuted — meetings render as point chips.** Demo meetings are date-only (`.../meetings/kickoff.md:3`) → all-day
  lane. Only a timed scalar with no end is a point chip. No timed value exists in demo-vault beyond two Z instants.
- **Refuted — `home-date-buckets.ts` guides "Coming up".** It buckets backward ("Last few minutes"…"Older",
  `apps/web/src/features/home/queries/home-date-buckets.ts:4-16`). Real guide: `features/meetings/.../upcoming-calendar-events.ts`.
- **Refuted — CALENDAR-12 e2e "07-29 due item first".** ops-5 and phx-421 fall on 07-28; ongoing lnc-2 sorts first under end > now.
- **Partial — connector tools uncallable from `-p`.** Live: strict init = 27 tools, 0 claude.ai; non-strict = 109 tools,
  40 claude.ai, Google Calendar connected. "Cannot call" holds only because the owner has no claude.ai allow rule;
  `--setting-sources user` imports 201 global allow rules (incl. `mcp__stripe__stripe_api_execute`, `mcp__scape__*`)
  on top of `--allowedTools`. → DOMAIN:mcp `--disallowedTools` or strict-by-default.
- **Partial — EventKit.** `objc2-event-kit` 0.3.2 permissive, objc2 `>=0.6.2,<0.8` matches lock 0.6.4. macOS 14 API
  handled by a runtime branch, not a floor raise. TCC persistence unmeasured.
- **Partial — V19 schema step.** USER_VERSION=18 here, 16 on main (V19 assumes M49–M52 merge). Many domains claim V19;
  roadmap M64.3 folds calendar reminders with AUTOMATION-8 and COMMS-5 → CALENDAR-6 owns no step.
- **Partial — exclusive vs inclusive ends.** `onDay('2026-07-25')` is true for `22:00 → 00:00` today; Macro ends are
  exclusive (`calendar-date.ts:69-71`). EventKit all-day end unverified.
- **Partial — span not persisted.** Settings panel already persists `calendarSpan` (`ViewSettingsPanel.tsx:954-962`);
  the in-view toggle is a one-line `onPresentationChange` wiring. Adding `day`/hours also touches `viewKinds.ts` (`KEY_NEEDS satisfies`, `:298-325`).
- **Partial — sha256 precedent.** `staleness.v1` has no sha256; the precedent is `freshness.v1`.
- **Unverifiable — `new Notification()` inert in packaged WKWebView.** Code path confirmed (no plugin, capabilities
  `core:default` + `dialog:default`, silent return `useReminders.ts:46-60`, toast always `:108`); the UI promises desktop
  notifications (`DatePicker.tsx:368-372`).
- **Corrected — roadmap M61.10 "on upstream rrule".** Macro uses no RRULE engine (no `rrule` in bun.lock/Cargo.lock).
  Adopting one is a new dependency decision.
- **Corrected efforts:** CALENDAR-6 M → S (re-scoped); CALENDAR-7 L → XL (split); CALENDAR-3 M conditional on DATA-9;
  CALENDAR-8 M conditional on DATA-5.
- **Confirmed:** Rust has no date-property parser (0 `daterange` hits); four TS readings of a Z instant; create-on-day
  defect (static + probe); `useTimeDrag` X-only whole-day, no select gesture (`:22-23, 140-144, 175-181`); reminder key
  `path#line@at` re-fires after a line insert (`reminders.ts:21`) and is global; reminders fire on `- [x]`
  (`reminders.ts:44-50`); 17 base tools, BM25 search; `ical` 0.11 Apache-2.0 licence file; FullCalendar 6.1.21 MIT;
  Macro's grid rules (30-min click slot, 07:00, no-drag set, next-hour 1 h default) — Macro has **no** keyboard event
  move, so CALENDAR-5's arrow snaps are Cerebro's own; ListCalendarEvents 200 / 370 d / `truncated`, no total;
  Macro copy availability reads missing data as free (`CopyAvailabilityDialog.tsx:78-89`); CALENDAR-3 window ~39 rows.
- **Missed items folded:** minute offsets, done-never-alerts, burst coalescing → CALENDAR-6; writer fix and TZ
  injection → CALENDAR-2/3/4; agent date writes unvalidated (`mcp.rs:2649-2671`) → CALENDAR-2 ↔ DATA-9; global allow
  rules → DOMAIN:mcp; CRLF fixtures → CALENDAR-8; addressable calendar position (`CalendarView.tsx:76` vs Macro
  `calendar-url.ts`) → DOMAIN:shell D11, low.

## 9. Where to read first

1. `apps/web/src/features/calendar/components/composer/event-form-model.ts` — selection → start/end, defaults (CALENDAR-1/5)
2. `apps/web/src/features/calendar/utils/calendar-date.ts` — exclusive ends, midnight rule (CALENDAR-2/4)
3. `crates/calendar_events/src/domain/models.rs` — `EventTime`, point events, `EventReminders`, `OccurrenceRange`
4. `crates/calendar_events/src/inbound/toolset/list_calendar_events.rs` — agenda shape + description (CALENDAR-3)
5. `apps/web/src/features/calendar/components/CalendarGrid.tsx`, `utils/event-interaction.ts`, `utils/time-grid-scroller.ts` (CALENDAR-4/5)
6. `crates/calendar_events/src/domain/reminder_dispatch.rs` + `crates/macro_db_client/migrations/20260810213910_calendar_event_reminders.sql`, `apps/web/src/features/calendar/utils/event-reminders.ts` (CALENDAR-6)
7. `apps/web/src/features/meetings/core/upcoming-calendar-events.ts` + `apps/web/src/features/meetings/queries/upcoming-calendar-events.ts` (CALENDAR-12)
8. `apps/web/src/features/calendar/utils/recurrence.ts` + `apps/web/src/features/calendar/hooks/use-event-editor.ts` — behaviour only (CALENDAR-7)
9. `crates/email/src/domain/calendar_invitation_parser.rs` (CALENDAR-8)
10. `crates/calendar_events/src/domain/team_availability.rs` — coverage rule (CALENDAR-9/11)
11. `crates/calendar_events/src/domain/service.rs` (`validate_upsert`, sync plan) + `crates/calendar_events/src/domain/team/models.rs` (CALENDAR-9/10)
12. `apps/web/src/features/calendar/availability/availability.ts` + `zone-label.ts` (CALENDAR-11)
13. `crates/calendar_events/src/domain/ports.rs` — why no forward scope
14. `docs/calendar-team-sharing.md`, `docs/CALENDAR_SCHEDULING_V1.md` — context for the skips
