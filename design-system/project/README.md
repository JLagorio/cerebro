Cerebro is a files-first markdown workspace: a desktop app where the vault on disk is the source of truth and the assistant is the person's own Claude Code. The interface is quiet graphite paper with one ultramarine accent (**cortex**) and one violet reserved for AI (**synapse**). It should read like a well-kept notebook, not a dashboard.

## Content fundamentals

- **Sentence case everywhere**: titles, buttons, menu items, dialog heads. "Add a property", "Change icon & color", "Conversation details". Never Title Case, never ALL CAPS except small group labels, which are uppercase by style.
- **Plain, specific, calm.** Say what happened and what the person can do. "It may have been renamed or moved to the Trash." "Pick a file from the tree." No exclamation marks, no emoji, no "Oops".
- **Second person, present tense, product-as-tool.** "Your open work, organized by when it needs you." "Every change in this vault is saved to history." Cerebro never speaks as "I"; the assistant does, inside its own conversation.
- **Explain the model in one line.** Empty and helper lines teach how the thing works: "Captures land here untyped. Giving a note a type is what takes it out of the Inbox."
- **Absent is never zero; unavailable is never empty.** A number nobody recorded reads as words ("not recorded", "unknown", "unattributed"), never `0` or `$0`. A read that failed says so ("Couldn’t read this page") and is never drawn as the empty state. "Nothing is waiting" and "we could not tell you what is waiting" are opposite sentences.
- **Name the actor.** Writes are attributed: "human:me", an agent's name, or "unattributed". Never imply a person did what an agent did.
- **Verbs on buttons.** "Verify", "Restore", "Allow", "Import". A destructive button names the act ("Delete", "Archive this"), never "OK".
- **Typographic punctuation**: curly quotes and apostrophes (’), the ellipsis character (…) on items that open a further step ("Convert to record…"), en dash in ranges, `⌘` glyphs in keycaps.

## Visual foundations

### Colour

- Grounds are neutral graphite (`n-0` … `n-900`). Use the semantic aliases, not the ramp, for anything structural:
  - `surface-app` for the canvas and pages; `surface-navigation` for the context sidebar; `surface-frame` for the icon rail and window frame (a step darker); `surface-board` for whiteboards; `surface-sunken` for wells; `surface-raised` for cards, menus, popovers and dialogs; `surface-selected` for a selected row.
  - `text-primary` for body and titles; `text-secondary` / `text-meta` for secondary text and metadata (both hold 4.5:1 on every neutral surface in both themes); `text-placeholder` for placeholders; `text-disabled` only for disabled labels (it is deliberately under 4.5:1).
  - `border-subtle` for hairlines; `border-strong` for control borders; `border-focus` plus the `ring` shadow for focus.
- **Cortex** (`cortex-50` … `cortex-900`) is the one brand hue. `accent` (= `cortex-500`) carries focus, links, the switch and filled cortex controls, and always takes a white label (`text-inverse`, 5.6:1 in both themes). Small links use `text-link`; in dark it moves to `cortex-300`.
- **Synapse** (`synapse-*`, `surface-ai`, `text-ai`) is for AI surfaces ONLY: assistant cards, AI blocks, the sparkle in an AI toast. Never use violet for ordinary chrome, and never use cortex to mean "AI".
- **The primary button is graphite, not blue.** `action-primary` is near-black in light and near-white in dark, with `on-action-primary` as its label. Blue is for focus and selection, not for "the main action". Destructive fills use `action-danger` / `on-action-danger`.
- Status: `success-*`, `warn-*`, `danger-*`. Pair `-50` grounds with `-700` ink; on a neutral surface, set status text in `-600`, which holds AA on every neutral surface in both themes. Every status also carries a word or icon; colour is never the only signal.
- **Option colours** (`opt-<hue>`, `opt-<hue>-bg`, `opt-<hue>-ink`) are the nine hues a select option, tag or workflow status draws from. Always draw a tag as `-ink` text on its `-bg` pill (≥4.5:1); the bare `opt-<hue>` is for dots and solid fills only.
- `swatch-*` (eight user-assignable hues for type icons, kanban cards and timeline bars), `ent-*` (entity identity), `status-*` (workflow flags), `health-*` and `canvas-1` … `canvas-6` (JSON Canvas presets) are fills and dots, never text on white. `avatar-1` … `avatar-8` are darkened so white initials clear 4.5:1.
- **Dark theme re-points the ramps** rather than restyling components: `n-0` becomes the darkest surface and `n-900` the lightest ink; `-50` stays "quiet ground of this hue" and `-700` stays "ink that reads on it". Write components against the ramps and aliases and both themes come for free. Elevation in dark reads as lighter: `surface-raised` sits above `surface-app`.
- No gradients. No coloured left-border cards. Selection highlight is `cortex-100`.

### Type

- Two families only: **Instrument Sans** (`--font-ui`, variable 400–700, with italic) for everything, **IBM Plex Mono** (`--font-mono`, 400/500/600) for code, paths, hashes, ids and keycaps. Both are SIL Open Font License 1.1.
- Use the **role** styles first: `page-title` (40/48, 600, −0.025em) above a document; `workspace-title` (24/32) for peeks and workspace heads; `section-title` (16/24, 600); `prose` (16/28) for document body; `ui` (14/20) for controls, menus and dialogs; `meta` (12/18) for metadata.
- The numeric scale (`text-2xs` 11 … `text-4xl` 42) is for deliberately compact chrome. The app body defaults to `text-sm` (13/20). Size and line height always travel as a pair (`fs-*` with `lh-*`).
- Weights: `w-regular` 400 body, `w-medium` 500 for buttons, tags and labels, `w-semibold` 600 for titles, `w-bold` 700 only for avatar initials.
- Tracking: `track-tight` on titles, `track-display` on display sizes, `track-caps` (0.06em) on uppercase AI section labels.

### Spacing, size and layout

- A **4px grid**: `sp-05` 2 · `sp-1` 4 · `sp-2` 8 · `sp-3` 12 · `sp-4` 16 · `sp-5` 20 · `sp-6` 24 · `sp-8` 32 · `sp-10` 40 · `sp-12` 48 · `sp-16` 64. Component paddings that are not on the grid (10px button padding, 14px toast left inset, 5px menu-row padding) are exact and intentional; keep them.
- Controls are `control-h` 32px by default, `control-h-sm` 28px in toolbars and property rows, `control-h-lg` 36px. Navigation rows are `nav-row-h` 36px.
- The shell: a `rail-w` 54px icon rail on `surface-frame`, a `sidebar-w` 240px resizable, collapsible context sidebar on `surface-navigation`, and a broad canvas on `surface-app` that meets the window's right and bottom edges with no border or gutter. Its single rounded top-left corner rests on the sidebar's background. Up to four page panes share the canvas.
- Measures: `surface-readable` 880px for documents, `surface-broad` 1120px for databases and Home, `surface-inset` 32px side inset. Composition insets step 16 → 24 → 32px at 600 and 960px container widths.

### Radii, borders, shadows

- Radii: `r-xs` 4 (kbd, inline code) · `r-sm` 6 (tags, icon buttons, menu rows, tooltips) · `r-md` 8 (buttons, inputs, selects, nav rows) · `r-lg` 10 (menus, toasts) · `r-xl` 14 (dialogs) · `r-full` (switch, pills).
- Borders do the separating; shadows only lift what floats. 1px `border-subtle` hairlines on cards and menus; `border-strong` on inputs and secondary buttons.
- Shadows are layered low-alpha ink: `shadow-xs` (selected segment, switch knob), `shadow-sm` (resting cards), `shadow-md` (popovers), `shadow-lg` (menus, toasts, dialogs, tooltips). In dark they lean on opacity, not hue.
- **Focus**: `border-focus` on the control's own border plus the `ring` shadow (3px of accent at 25%, 45% in dark). Navigation rows use a 2px `border-focus` outline inset by 2px. Focus is always visible on keyboard focus (`:focus-visible`) and never removed.

### Motion

Motion is named by kind, never by number; every call site spends a pair from `components/bundle.css`.

| Kind   | Pair                                                      | Use                                                                               |
| ------ | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| hover  | `--motion-hover` 20ms ease-in                             | Washes on rows and buttons. An anti-flicker guard, not a fade: never lengthen it. |
| move   | `--motion-move` 200ms ease                                | Anything that slides or resizes in place.                                         |
| enter  | `--motion-enter` 240ms cubic-bezier(0.16, 1, 0.3, 1)      | Panels, drawers, dialogs, the assistant arriving.                                 |
| pop    | `--motion-pop` 160ms, same curve                          | Menus, tooltips and popovers opening under the pointer.                           |
| exit   | `--motion-exit` 140ms cubic-bezier(0.4, 0, 1, 1)          | Anything leaving: quicker than it came.                                           |
| turn   | `--motion-turn` 200ms, enter curve                        | A chevron folding, the segmented pill sliding.                                    |
| spring | `--motion-spring` 240ms cubic-bezier(0.34, 1.56, 0.64, 1) | A mark landing: a count, a check, the switch knob. Never a whole surface.         |

Pressed buttons give a little (`scale: .98`, icon buttons `.92`). Under reduced motion every duration but hover collapses to 0. Entrances fill `backwards`, exits `forwards`, so no transform outlives an animation.

### States

Every section that reads data has five states: ready, empty, not recorded, partial and unavailable. Draw the last four with `StateMessage`: an unavailable read gets the `danger-200` border and `danger-700` icon and its own words, never the empty state. Disabled controls drop to 45% opacity with `cursor: not-allowed`; disabled text uses `text-disabled`.

## Iconography

- **Lucide** (lucide-react 0.525), line icons at **1.75 stroke**, `currentColor`, 16px by default (14px in small controls, 12–13px in tags and menus). Name icons in kebab-case (`circle-alert`, `layout-grid`). Old Lucide names (`alert-circle`, `check-square`) are aliased; an unknown name draws `square-dashed` so a bad icon is visible, never blank.
- The **Icons** asset group holds the 266 Lucide icons the app names, drawn exactly as `Icon` draws them (24px viewBox, 1.75 stroke, round caps and joins, `currentColor`). Inline an SVG to colour it with CSS `color`; as an `<img>` it draws black. In React, use `Icon` (`window.Cerebro.Icon`) with the kebab-case name instead of the file.
- Icons inherit their text colour. Menus tint leading icons `n-500`; empty states use a 1.5 stroke in `n-400` inside a 48px `r-lg` well on `n-50`.
- Two marks are drawn in code, not taken from Lucide: the filled workflow **status flag** (`StatusFlag`) and the context-usage **ring** (`Context`).
- No emoji in product chrome. Unicode `⌘ ⌥ ⇧ ↵` appear only in keycaps.

## Logo

The mark is typographic: a lowercase **c** and a period, "c.", set in Instrument Sans 700 at 30/34px with −2px tracking, the c in `text-primary` and the period in `text-secondary`. It sits at the top of the icon rail as the Home button (`.m71-brand` in `src/app/shell.css`; see the AppRail card). The product name in running text is "Cerebro". The app icon is a flat graphite square (`#1a1d21`). Set the mark in type; never draw it as an image or invent another.

## Components

The cards below mount the real components from `src/components/ui/` (the design-system primitives), `src/components/ai/` (the AI elements: Cerebro's port of shadcn AI Elements), `PageHeader` and `ListSelectionBar`. Every export is on `window.Cerebro`; `components/index.d.ts` has their props. The App shell cards (AppShell, AppRail, Sidebar, PageToolbar) are compositions of the app's own markup and classes, because those components read app state.

- Load, in order: `tokens.css`, `components/bundle.css`, `components/lib/react.production.min.js`, `components/lib/react-dom.production.min.js` (React 19.2, as `window.React` / `window.ReactDOM`), then `components/bundle.js`. Mount with `ReactDOM.createRoot(el).render(React.createElement(Cerebro.Button, { variant: 'primary' }, 'Publish'))`. Set `data-theme="light"` or `"dark"` on `<html>`.
- Use the primitives; never a native `<select>` (use `Select`), never `text-white` (use `text-inverse`), and never a raw hex in a component (name a token).
- The AI elements are presentation only: hand them plain props and view models; they never read a store, IPC or the agent model. `synapse` colours belong to them alone.
- Overlays (menus, popovers, tooltips, dialogs) portal to `document.body` and stack through one layer list; Escape closes the top layer only.
- Notices for the open-source code inside the bundle (React, Lucide, Shiki, the shadcn AI Elements port, Tailwind's preflight and others) are in `components/THIRD_PARTY_NOTICES.txt`.

---

Not synced: the motion tokens live in `components/bundle.css` (the token format has no motion family). Code highlighting in the bundle carries Shiki grammars for TypeScript, TSX, JSON, shell, Markdown, Rust, Python, CSS, diff, YAML and TOML; other languages render as plain text, which is the component's own fallback.
