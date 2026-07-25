# Cerebro Design System

Cerebro is an **internal product system**: a Productboard-class tool for defining objectives and key results, relating them to products, components, features, subfeatures, initiatives, and releases — wrapped around a service-layer **knowledge base + AI system** (the "Cerebro" agent). It is used by internal teams only: no customers, no trials, no upsell surfaces.

**Important provenance note.** The source material (below) documents Productboard's UI. Cerebro deliberately does **not** copy Productboard's brand or visual identity (logo, colors, typeface, chrome styling). What it borrows is the unprotectable workflow genre: entity hierarchy, boards (table / timeline / kanban), detail side panels, board controls, and an AI insights layer. Everything visual here is an original identity built for Cerebro.

## Sources provided
- `uploads/*.pdf` — Productboard marketing/support articles: "Introducing Productboard Spark" (agentic product system), "Spark: Findings and opportunities", and three Use Case pages (Roadmapping, Strategy, Operations). Working copies: `uploads/spark-intro.pdf`, `uploads/spark-findings.pdf`, `uploads/roadmapping.pdf`, `uploads/strategy.pdf`, `uploads/operations.pdf`.
- `uploads/Screenshot 2026-07-18 at 8.4x–8.5x PM.png` (~53 images) — Productboard app tour: Initiatives grid + timeline, Features board, Strategic OKR Planning (objectives + key results + health), Delivery Planning (features/subfeatures/releases), Kanban Roadmap, Board controls panel, Add-feature hierarchy popover, Feedback repository + note detail with AI summary, Findings/Opportunities (empty states), Agent (skills editor, scheduled automations modal).
- Entity model (user-specified, mirrors `developer.productboard.com/reference/listentities`): `product, component, feature, subfeature, initiative, objective, keyResult, release, releaseGroup, user, company`. Internal tool → users/companies are internal teams & stakeholders, not tracked customers.

## Product model
- **Hierarchy:** Product → Component → Feature → Subfeature. Features link to Initiatives and Releases; Initiatives roll up to Objectives; Objectives own Key Results with health (On track / At risk / Off track).
- **Views:** every collection renders as a *board* with three layouts — **Grid** (grouped table), **Timeline** (quarter/month gantt), **Columns** (kanban) — plus a right-hand **Board controls** panel (layout, filters, groups) and a right **detail panel** per entity (tabs: Details, Spec, Resources, Insights, Health).
- **Knowledge & AI ("Cerebro"):** central ask-bar ("Search or ask Cerebro… ⌘K"), signals (internal feedback) repository with AI summaries, **Findings** (recurring signals) synthesized into **Opportunities** (evidence-backed problems with strategy alignment), specialized agent **skills**, and **scheduled automations**.
- **App shell:** far-left icon rail (Home, Agent, Library, Settings) → contextual sidebar (nav tree, recents, favorites, spaces/boards) → canvas → transient right panels.

## CONTENT FUNDAMENTALS
- **Sentence case everywhere** — nav, buttons, column headers, dialog titles: "Create objective", "Add filter", "Board controls", "My items". Never Title Case, never ALL CAPS except tiny eyebrow labels (`11px/600/+0.06em`).
- **Verb-first actions**: "Create initiative", "Link feature", "Add grouping", "Mark processed". Destructive verbs are plain ("Delete view"), never cute.
- **You/your voice, we for the agent's work**: "Your objectives", "Cerebro spots recurring signals in your feedback". The AI is named **Cerebro** and speaks plainly, never with hype.
- **Empty states**: short declarative headline + one helper sentence + one primary action. E.g. "No findings surfaced just yet" / "Cerebro spots recurring signals as knowledge accumulates." / [Add knowledge].
- **Traceability copy**: AI outputs always cite sources ("From 6 signals · 4 teams"). If Cerebro can't ground it, it doesn't say it.
- **No emoji. No exclamation marks.** Numbers are quiet facts: "40%", "Q3 2026", "8 items". Dates as "Jun 2026 → Oct 2026" (arrow, not dash) for ranges; "Q3, 2026 – Q4, 2026" for timeframes in tables.
- **Sample/placeholder convention**: suffix "(Sample)" on seeded content.
- **Keyboard affordances** shown in mono kbd chips: ⌘K, ⇧⌘P.
- **Internal-tool tone**: matter-of-fact, zero marketing. Labels are nouns ("Objectives, Key results"), meta info is "· "-separated.

## VISUAL FOUNDATIONS
- **Vibe**: calm, dense-but-airy productivity chrome. White canvas, cool graphite text, one decisive ultramarine, violet reserved exclusively for AI. Flat color, no gradients anywhere (the sole exception: none — even AI surfaces are flat tints).
- **Color**:
  - Neutrals: 12-step cool graphite ramp (`--n-0…--n-900`, hue ≈ 262).
  - Primary **Cortex** ultramarine `--cortex-500 #3D5BDE` (hover 600, press 700) — buttons, links, selection, focus.
  - **Synapse** violet `--synapse-500 #8250DC` — *only* for AI/agent surfaces (ask-bar icon, AI summary blocks, agent chips). Never for generic emphasis.
  - Semantic: success `#1F9D61`, warning `#DE8F0A`, danger `#DE3B4E`; 50-tints for washes.
  - **Entity colors** (fixed, semantic): objective amber, key result green, initiative cortex, feature cyan, subfeature sky, product slate, component teal, release vermilion, release group rust, company pine, user slate. Features/kanban cards may take an 8-swatch user-assignable color.
  - Status defaults: New idea teal, Planned blue, In progress amber, Validation violet, Released green, Won't do gray; Health: on track green / at risk amber / off track red.
- **Type**: UI + display = **Instrument Sans** (variable, 400–700). Data/IDs/kbd = **IBM Plex Mono** (400/500/600). Base UI size 13px/20; page titles 20px/600/-0.01em; display 32px/700/-0.02em. Uppercase eyebrows 11px/600/+0.06em.
- **Spacing**: 4px grid (`--sp-1…--sp-16`). Table rows 40px, headers 36px; sidebar items 32px; controls 32px (md) / 28px (sm).
- **Backgrounds**: flat. App canvas white; sidebar & sunken wells `--n-50`; board canvas `--n-25`. No imagery, no textures, no patterns. Empty-state art = simple line illustrations in neutral grays (never photos).
- **Borders**: 1px hairlines `--n-200` (subtle) / `--n-300` (strong). Tables use row hairlines + column separators only in headers.
- **Radii**: 4 (xs chips) / 6 (sm tags, small buttons) / 8 (buttons, inputs) / 10 (cards) / 14 (modals, floating panels) / full (pills, avatars).
- **Shadows**: layered, low-alpha ink (see `--shadow-xs/sm/md/lg`). Cards = shadow-sm + hairline; popovers = md; modals & floating panels = lg. No inner shadows, no glows.
- **Hover**: background wash (`--n-50`→`--n-100`), never opacity or color shifts on text; icon buttons get wash + icon darkens. **Press**: one step darker wash; buttons go to 700. **Selection**: `--cortex-50` wash + `--cortex-500` left rail or border. Rows highlight with `--n-50`; selected rows `--cortex-50`.
- **Focus**: 2px `--cortex-500` border + 3px 25% ring (`--ring`). Always visible for keyboard.
- **Motion**: fast and dry — 120ms ease-out for hovers, 180ms for panels sliding in (translateX 8px + fade). No bounces, no scale animations. Skeletons pulse at 1.2s.
- **Transparency/blur**: none in chrome. Scrims are flat `rgba(22,26,36,.4)`; no backdrop-blur.
- **Cards**: white, 1px `--n-200`, radius 10, shadow-sm, 4px colored **top-edge or left-edge bar** only on kanban cards (entity/status color) — this is a data encoding, not decoration.
- **Data viz**: progress bars 4px rounded track `--n-100` + cortex fill; timeline bars 8px pills in entity/swatch colors; avatars = initials on muted saturated bg.
- **Layout constants**: icon rail 56px fixed; sidebar 264px; top bar 64px with centered 520px ask-bar; detail panel 420px; board-controls panel 320px.
- **Imagery**: none in-product. If ever needed (docs, decks): neutral, cool-toned, abstract geometry — never stock photos of people.

## ICONOGRAPHY
- **Icon set: [Lucide](https://lucide.dev) via CDN** (`lucide@0.462.0` UMD + `data-lucide` attributes). This is a **substitution**: the source app uses a proprietary line-icon set; Lucide matches its 1.5–1.75px stroke, rounded-join genre. Use the `Icon` component (`components/core/Icon.jsx`) or `assets/icons.js` helper; stroke-width 1.75, sizes 14/16/18/20; color `currentColor`.
- **Entity glyph map** (fixed — see `EntityIcon`): objective `target`, keyResult `trending-up`, initiative `diamond`, feature = filled rounded **square** glyph (CSS, swatch-colored), subfeature = filled **dot** glyph, product `package`, component `layout-grid`, release `flag`, releaseGroup `flags`, company `building-2`, user `circle-user`, signal/feedback `message-square-text`, finding `radar`, opportunity `lightbulb`, agent/AI `sparkles`, board `table-2`, kanban `kanban`, timeline `calendar-range`, spaces `layers`.
- Status flags use `bookmark` (filled, status-colored). Health chips use `circle-check` / `circle-alert` / `circle-x`.
- **No emoji as icons. No hand-rolled SVGs.** Unicode used only for `⌘`/`⇧` in kbd chips and `→` in date ranges.
- **Logo**: no logo asset was provided and none is invented. The brand mark is the wordmark "cerebro" set in Instrument Sans 700, lowercase, ink (`--n-900`), with a `--synapse-500` terminal period: **cerebro.** — see `assets/wordmark.html` spec card. Flagged: supply a real mark to replace it.

## FONTS & SUBSTITUTION FLAG
Original brand → faces chosen from Google Fonts and shipped in `assets/fonts/`: Instrument Sans (variable + italic) and IBM Plex Mono (400/500/600). `@font-face` lives in `tokens/fonts.css`. If Cerebro later standardizes different faces, replace the binaries and the tokens only.

## Index
- `styles.css` — global entry; imports everything under `tokens/`.
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css` (space/radius/shadow/layout/motion), `base.css` (resets, links, scrollbars, kbd).
- `guidelines/` — foundation specimen cards (Design System tab).
- `assets/` — `fonts/`, `wordmark.html`.
- `components/` — reusable primitives (each: `.jsx` + `.d.ts` + `.prompt.md` + card): `core/` Button, IconButton, Input, Select, Checkbox, Radio, Switch, SegmentedControl, Icon · `display/` Badge, Tag, Avatar, Card, EntityIcon, HealthChip, ProgressBar, StatusFlag · `navigation/` Tabs, FilterChip · `feedback/` Dialog, Tooltip, Toast, EmptyState · `ai/` AskBar, AISummary · `boards/` KanbanCard.
- `ui_kits/cerebro/` — full app recreation: interactive `index.html` shell + screens (OKR board, roadmap timeline, delivery kanban, knowledge/AI, board controls, detail panel).
- `templates/cerebro-app/` — "Cerebro app shell" template for consuming projects (opens on any of the five views via the `initialView` tweak).
- `SKILL.md` — agent-skill entry point.

### Intentional additions (no component library was provided; inventory authored from observed screens)
Standard set (Button…Toast) plus domain primitives observed in the genre: `EntityIcon`, `StatusFlag`, `HealthChip`, `ProgressBar`, `SegmentedControl`, `FilterChip`, `AskBar`, `AISummary`, `EmptyState`, `KanbanCard`, `Avatar` — each exists because the core screens require it.
