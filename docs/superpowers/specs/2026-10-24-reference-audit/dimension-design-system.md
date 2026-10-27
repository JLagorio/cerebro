# Design system and components - Cerebro vs 10 reference apps (2026-10-24)

> Cross-checked 2026-10-27; see codex-crosscheck/.

> **Scope:** tokens, styling technology, theming, primitives, conventions, docs and rails. Inputs: `affine-3-design-system`, `outline-3-design-system`, `cerebro-baseline-ui`, the DS sections of the 8 deltas, `plans/2026-10-22-ui-refresh-review/02-visual-system.md` (VS), the M94 spec/plan and `specs/2026-10-23-m94-ui-implementation/composition-sheet.md`. Cross-referenced with sibling stage-2 files `audit-m94a.md` (M94A-*), `audit-m94b.md` (M94B-*), `audit-m93.md` (M93-*).
> **Method:** every Cerebro count re-measured on today's dirty tree (commands below). Reference claims that decide a row were re-opened. Contrast values computed from `src/styles/tokens/colors.css` with WCAG 2 relative luminance by a read-only script [calc]. Nothing built, run, installed or edited except this file.
> **Basis:** [read] code read · [names] file or dir names · [docs] dossier, README or comment · [calc] computed.
> **Aliases, licences** (all under `docs/examples/`): `AF/` AFFiNE-canary, MIT outside `packages/backend`, `packages/common/native` (`AFC/` = `AF/packages/frontend/component/src/`) · `O/` outline-main, BSL, ideas · `PL/` plane-preview, AGPL, ideas · `AP/` activepieces-main, MIT outside `packages/ee` (`APW/` = `AP/packages/web/src/`) · `N8N/` n8n-master, SUL, ideas (`DS/` = `N8N/packages/frontend/@n8n/design-system/src/`) · `MAC/` macro-main/apps/web, AGPL + all rights reserved, ideas · `AFY/` AppFlowy-main/frontend/appflowy_flutter, AGPL, ideas (`AFUI/` = `AFY/packages/appflowy_ui/`) · `M/` Morrow-main, Apache-2.0 · `TD/` thought-desk-main, AGPL, ideas · `T/` tolaria-main, AGPL, ideas.

## Bottom line

- **Keep the system. Migrate nothing.** Cerebro enforces more than any of the ten: off-DS classes compile to nothing and fail a test, AA pairs are tested in both themes, motion is tokens with a shipped-bytes test, one layer stack, one keymap, five read states, element rails (CV-61/63/64), 61 primitive test files. No library swap (Radix, sonner, kbar, vaul) or styling swap (vanilla-extract, styled-components, Storybook) pays for itself.
- **What is missing is the role layer between ramps and components.** References converge: translucent hover/press layers (6 repos), a distinct dark overlay surface (6), named z layers (4, plus Thought Desk's consistent ladder), shadows named by role (7), ink/line role utilities (Plane: 3,510 role vs 30 raw). Cerebro: 274 opaque `hover:bg-n-*`, overlays filled with the page ground in dark, 17 raw z values with a three-way tie at 1100, size-named shadows plus 24 off-token ones, 3,266 raw-ramp vs 217 role colour refs. → owner-gated `M94.new-ds-roles` before M94.6–M94.8 adopt.
- **Five P0s in today's tree:** ContextMenu is outside the layer stack (letters and chords reach the page while it is open; a capture-phase Popover beneath takes Escape first; its items cannot carry the disabled blockers M94.5 requires). M94.4's creation Enter guards miss WebKit's post-composition `keyCode 229` (`src/app/CreateMenu.tsx:159`, `src/app/RecordComposer.tsx:169`, `src/app/CreateLauncher.tsx:101`; M94B-A09). Three undefined CSS variables paint a light-only fallback or nothing. Raw-step ink fails AA (synapse-600/700 in dark 2.22/1.70:1; light `text-n-400` 3.49:1 ×314, `text-n-500` 3.99–4.35:1 ×443), and new M94.4 copy repeats it (`src/app/CreationDraftRecovery.tsx:22`). Zero render boundaries (M93-N01 owns them).
- **Build missing primitives first, then adopt under down-only ratchets:** pending Button, Skeleton, Checkbox, Textarea, tablist hook, Dialog sizes, toast tone/key, settings kit, required-branch read view. AppFlowy shows adoption-by-rebuild with no rail: 4 new popovers vs 136 legacy.
- **Docs:** extend the lab with a `?specimen=` matrix (variant × size × state × theme), recorded as component evidence. No Storybook.
- **Theming:** fixed identity (UX-01). No custom themes or accents. A contrast variant (`prefers-contrast: more`, Plane precedent) is the only theme worth an owner call.

### Counts behind this file (re-measured 2026-10-24; `$TS` = `src -g '*.{ts,tsx}' -g '!*.test.*'`)

| Metric | Count | Cmd |
| --- | --- | --- |
| Raw `<button>` vs `<Button>` / `<IconButton>` | 590 in 235 files (552 outside `components/ui`,`ai`) vs 239 / 79 | 1 |
| `hover:bg-n-*` washes | 274 in 132 files: n-50 204 · n-100 46 · n-25 21 · n-200 3 | 2 |
| z-index literals | ≈133, 17 values (1–1100): `z-N` 94 · `z-[N]` 14 · CSS 19 · TS strings 6. Tooltip = HoverCard = Toast = 1100 | 3 |
| Raw-ramp vs role colour refs (TSX) | 3,266 vs 217 (45 role utilities · 23 `-[var(--role)]` · 149 `-(--role)`, 148 of them `text-(--text-meta)`) | 4 |
| Low-contrast ink classes | `text-n-400` 314 · `text-n-500` 443 (193 files) · CSS `color: var(--n-400/500)` 44 (some are icons: 3:1 applies) | 5 |
| Shadows off-token | 5 literal `shadow-[…rgba]` · 19 stock Tailwind `shadow-sm/lg` · vs 48 `shadow-[var(--shadow-*)]` | 6 |
| Dialog widths | 23 sites, 9 values (420–960) + default 560 | 7 |
| Hand-rolled unavailable | 53 `data-testid="section-unavailable"` in 40 app files (lab excluded) vs 26 `StateMessage` importers | 8 |
| Raw form controls | checkbox 15 (3 looks) · `<textarea>` 20 · radio 4 · hand-built `role="tablist"` 7 files | 9 |
| Toast calls | ≈432 in 120 files (149 `.toast(` + 283 bare `toast(`); host never passes a tone | 10 |
| Undefined CSS vars | `--info-50`, `--info-700` (`src/knowledge/FacetChips.tsx:27`), `--danger` (`src/workspace/RootMountDialog.tsx:65`); dead hook `--floating-chat-available-height` (`src/agent/chat.css:107`) | 11 |
| Geometry/type escapes | 364 `-[Npx]` · 12 `text-[Npx]` (12.5px ×2, 10px) · 114 `leading-[…]` · 30 CSS literal font sizes (12 values) · 28 CSS literal radii vs 102 `var(--r-*)` | 12 |
| Responsive model | 2 viewport variants vs 32 container variants + 17 `@container`; 3 `@media` width rules | 13 |
| Motion escapes | 0 `transition-all` · 0 `duration-N` · 0 CSS `transition: all` (the 1 hit is a comment, `src/styles/motion.css:13`) · 10 literal `ms` outside the token file (`src/editor/outline.css` ×9, `src/editor/editor.css:781`) | 14 |
| Primitive tests | 61 test files in `components/ui` + `ai`; untested: EmptyState, IconButton, StatusFlag, Switch, Tag, Toast | 15 |

```
1  rg -o '<button\b' src -g '*.tsx' -g '!*.test.tsx' | wc -l        # + -g '!src/components/ui/**' -g '!src/components/ai/**'
   rg -o '<Button\b' src -g '*.tsx' -g '!*.test.tsx' | wc -l ; rg -o '<IconButton\b' src -g '*.tsx' -g '!*.test.tsx' | wc -l
2  rg -o 'hover:bg-n-[0-9]+' $TS --no-filename | sort | uniq -c
3  rg -o -P '(?<![\w-])-?z-[0-9]+(?![\w-])' $TS ; rg -o 'z-\[[^\]]+\]' $TS ; rg -o 'z-index:\s*[^;]+' src -g '*.css'
   rg -o 'zIndex:\s*[^,}]+|z-index:\s*[0-9]+' $TS
4  rg -o -P '(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|fill|stroke|outline|divide|decoration|accent|caret|placeholder|from|to|via|shadow)-(?:n|cortex|synapse|success|warn|danger)-\d{1,3}(?:/\d+)?(?![\w-])' $TS
   rg -o -P '(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|outline|divide|decoration|accent|caret|placeholder)-(?:surface-[a-z-]+|accent(?:-hover|-press)?|inverse|action-[a-z-]+|on-action-[a-z-]+)(?:/\d+)?(?![\w-])' $TS
   rg -o -P '(?:bg|text|border|ring|fill|stroke|outline)-\[var\(--(?:surface|text|border|accent|action|on-action)[a-z-]*\)\]' $TS ; rg -o -P '[a-z]+-\(--[a-z0-9-]+\)' $TS
5  rg -o -P '(?<![\w-])(?:[a-z-]+:)*text-n-(400|500)(?:/\d+)?(?![\w-])' $TS ; rg -o -P 'color:\s*var\(--n-(400|500)\)' src -g '*.css'
6  rg -o 'shadow-\[[^\]]*rgba[^\]]*\]' $TS ; rg -o -P '(?<![\w-])(?:[a-z-]+:)*shadow-(?:xs|sm|md|lg|xl|2xl)(?![\w-])' $TS ; rg -o 'shadow-\[var\(--shadow-[a-z]+\)\]' $TS
7  rg -o -U -P '<Dialog\b(?:(?!>)[\s\S]){0,400}?width=\{([0-9]+)\}' src -g '*.tsx' -g '!*.test.*'
8  rg -o 'data-testid="section-unavailable"' src -g '*.tsx' -g '!*.test.*' -g '!src/components/ui/StateMessage.tsx' -g '!src/lab/**'
9  rg -o 'type="checkbox"' $TS ; rg -o '<textarea\b' $TS ; rg -o 'type="radio"' $TS ; rg -l 'role="tablist"' $TS
10 rg -o '\.toast\(' $TS ; rg -o -P '(?<![\.\w])toast\(' $TS ; rg -l '\btoast\(' $TS
11 read-only script: every var(--x) in src/**/*.{css,ts,tsx} minus CSS `--x:` and TS '--x' / setProperty definers
12 rg -o -P '(?<![\w])[a-z-]+-\[-?[0-9.]+px\]' $TS ; rg -o -P 'text-\[[0-9.]+px\]' $TS ; rg -o -P 'leading-\[[^\]]+\]' $TS
   rg -o -P 'font-size:\s*[0-9.]+px' src -g '*.css' ; rg -o -P 'border-radius:\s*[0-9.]+px' src -g '*.css'
13 rg -o -P '(?<![\w@/-])(?:sm|md|lg|xl|2xl):[a-z]' $TS ; rg -o '@container' src -g '*.css' ; rg -o -P '@media[^{]*(width|min-width|max-width)' src -g '*.css'
14 rg -o -P '(?<![\w-])transition-all(?![\w-])' $TS ; rg -o -P '(?<![\w-])duration-[0-9]+(?![\w-])' $TS ; rg -n 'transition:\s*all' src -g '*.css'
15 find src/components/ui src/components/ai -name '*.test.ts*' | wc -l
```

Fit re-run, later 2026-10-24: concurrent M93–M99 work drifts cmd 1 (591 in 235, 553 outside, vs 248 / 79), cmd 4 (3,277 vs 225; 156 `text-(--text-meta)`), cmd 5 (`text-n-500` 444), cmd 8 (55 in 41), cmd 10 (≈434), cmd 12 (108 `var(--r-*)`). Prose below keeps the first measurement; DS-20 re-measures at commit.

## Token architecture compared

Cells [read] unless marked. Plane's and AFFiNE's token values are unvendored npm packages, so only names and call sites are visible there.

| Role | Cerebro | AFFiNE | Outline | Plane | Activepieces | n8n | Macro | AppFlowy | Thought Desk | Morrow · Tolaria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Token files | `src/styles/tokens/{colors,spacing,typography}.css`; `src/styles/index.css` `@theme inline` | npm `@toeverything/theme`; role mirror `AF/packages/frontend/apps/android/App/app/src/main/java/app/affine/pro/theme/Colors.kt` | `O/shared/styles/theme.ts`, `depths.ts` | rules `PL/packages/tailwind-config/AGENTS.md`; values in `@makeplane/propel` | `APW/styles.css`; `AP/brain/knowledge/design-system/colour.md` | `DS/css/_primitives.scss`, `_tokens.scss`; `N8N/packages/frontend/@n8n/frontend-constants/src/z-indexes.ts` | `MAC/src/index.css` (1,778 lines) | `AFUI/script/*.tokens.json` → `generate_theme.dart`; `AFUI/lib/src/theme/data/shared.dart` | `TD/src/app.css:49-459` | `M/src/app/styles/tokens.css`; `T/src/index.css:32-383` |
| Surfaces, layers | 8 roles `--surface-{frame,navigation,app,board,sunken,raised,selected,ai}`; overlays fill `--n-0` = app ground in dark | primary/secondary/tertiary/**overlayPanel**/modal; dark overlay Grey900 on Grey950 | background + component names (`menuBackground`) | canvas once → surface-1..3 → layer-1..3, written rules | gray steps 1–2 + named `--panel` | `--background--surface/subtle/inverse` | depth-relative `surface-0…4` via `<Layer>` | layer-01..04 = Neutral 900/850/850/830 in dark, lighter with depth (`AFUI/script/Semantic.Dark Mode.tokens.json`) | bg · sidebar · elevated · grouped · translucent material | M bg/sidebar/surface/**popover**; T app/sidebar/panel/card/popover/dialog |
| Ink, text | 9 `--text-*` roles; one mapped utility (`text-inverse`, `src/styles/index.css:100`): TSX 3,266 raw-ramp vs 217 role refs | text primary/secondary/disable/emphasis; icon roles | text, textSecondary, textTertiary, placeholder | role utilities: 3,510 vs 30 raw | step 11 low-contrast text ≥4.5:1; step 12 text | `--text-color`, `--subtle`, `--subtler`, `--disabled` | ink, content-0…, ink-subtle | Text + Icon roles | text, text-2/3/4 | M text/muted/faint; T muted 2.07:1 [docs] |
| Lines, borders | `--border-{subtle,strong,focus}`, opaque n-200/n-300; call sites use `border-n-*` (507) | `layer/insideBorder/*` (value unvendored); the Android mirror's divider is translucent (`TransparentGrey400`, 22%, `Colors.kt:335`) | divider, inputBorder | border-subtle/strong | steps 6–8 | translucent `--border-color--subtle/strong/stronger` | hairline, edge tokens | Border roles | separator(-strong), 8% hairline | M border/strong; T default/subtle/strong/input/focus |
| Accent | cortex 50–900 + `--accent/-hover/-press`; synapse = AI only; `--action-*` fills hold white ≥4.5:1 | brand emphasis | one accent; custom accent | brand scale; 2-seed custom | 12-step accent; tenant seed | brand + hover/active/focus/disabled | theme input; `accent-bg` 8% | theme blue | graphite (accent = ink) + 10 options | M 8 accents; T blue + tints |
| Semantic states | success/warn/danger 50/500/600/700; no info scale though `--info-*` is used; `--opt-*` triples, ink ≥4.5:1 on its pill | success/error/warning/progressing grounds | danger, warning, success | (unvendored) | 12-step scales, one job per step | status quads bg/border/text × 4 tones | 12 hue inputs | same badge colours in both themes [docs] | danger + system colours | M danger(+soft); T feedback text/bg × 4 |
| **State layers** (hover, press, selected) | none: 274 opaque `hover:bg-n-*`, 7 ad hoc `color-mix` ink washes (`src/app/shell.css:62,335`, `src/agent/chat.css:230,233,436`, `src/editor/outline.css:180`, `src/editor/editor.css:325`), two commented "so hover lifts … in dark as it shades it in light"; selected = opaque `--surface-selected` | `::before` `hoverOverlay` painted over the label, so translucent (value unvendored) (`AFC/ui/button/button.css.ts:44-62`) | light opaque warmGrey, dark `white10`; selected accent 10% | `-hover/-active/-selected` per layer (values unvendored) | opaque steps 3–5; "Never tint a surface … use the step" (`colour.md`) | black-alpha-50/100; dark white-alpha (`_tokens.scss:14-15,662`) | ink 3%/6%, accent 8%/16% (`MAC/src/index.css:266-276`) | ink 5%/10%, brand 15%/20% | fill 4/6.5/10%; selection 13% ink | M ink .05/.085 (`tokens.css:30-31`); T opaque `#EBEBEA` |
| **Elevation, shadows** | size-named `--shadow-xs…lg` (dark alpha 0.4–0.6) + `--ring`; 19 stock Tailwind + 5 literal shadows bypass them | `menuShadow` on `overlayPanel` (`AFC/ui/menu/styles.css.ts:15-16`), `popoverShadow` (`AFC/ui/modal/styles.css.ts:179`) | `menuShadow`, `modalShadow` per theme | `shadow-raised-*` vs `shadow-overlay-*` (`PL/packages/blocks/src/select/menu-parts.tsx:43-53`) | edge/rest/lift/over/panel (`APW/styles.css:221-225`) | primitives + dark overrides | bundles `menu-surface`, `elevated-surface`, `--shadow-menu` | small/medium, 12% vs 48% dark | sm/pop/modal + frosted | M popover/dialog; T shadcn |
| **Depth, z-index** | no tokens; ≈133 literals, 17 values; 1100 tie ×3; Popover 1050 and scrim 1000 ordered only in comments | `zIndexModal` ×11, `zIndexPopover` ×4, local 0–5; outliers 9999 / 99999 / 2³¹−1 | one table `depths.ts` (toc 100 → tooltip 50000) | (unvendored) | ad hoc (z-50 ×38, z-9999) [docs] | `APP_Z_INDEXES`, 23 names → CSS vars at boot (`setAppZIndexes`) | banded tokens 0–99 · 100–199 · 200–299; raw z only in local contexts (`index.css:584-662`) | Flutter overlay (n/a) | literal ladder 1–300 | literals (M 39–70; T to 13000, plus a 2³¹−1 fatal-error overlay `T/src/main.tsx:210`) [read grep] |
| Radius | `--r-*` 4/6/8/10/14/full; 28 literal CSS radii (12 ×4, 24 ×3, 7 ×3…) | literals 8/12; `calc(outer − padding)` (`AFC/ui/radio/styles.css.ts:13`) | `borderRadius` mixin (superellipse) | (unvendored) | shadcn `--radius` | 2–20 scale | in role bundles | 4/6/8/12/16/20 | 6–16 + written concentric rule | M 4/6/10; T one `--radius` |
| Spacing | 4px `--sp-05…16` = Tailwind spacing; layout tokens (rail 54, sidebar 240, nav row 36, control 28/32/36); 364 arbitrary `-[Npx]` | literals | literals | page gutters `px-page-x` [docs] | Tailwind | `--spacing--5xs…5xl` 2–256 | Tailwind | 4/6/8/12/16/20 | fluid `clamp(48px,9vw,112px)`, per pane | literals |
| Type scale, roles | roles 40/48 · 24/32 · 16/24 · 16/28 · 14/20 · 12/18 + numeric 11–42; size rail; escapes 12 `text-[Npx]`, 30 CSS literals | `fontXs/Sm/Base` vars + literals | weights only; sizes literal | two scales coexist (×504 vs ×49) [docs] | Tailwind | rem scale 8–28px, no roles | Tailwind, 15px base [docs] | 8 roles × 3 weights | 5 whole-px sizes 11–15; weights trimmed in dark | M 4 half-px sizes; T 167 `text-[10–13px]` [docs] |
| Motion | kind pairs: hover 20 · move 200 · enter 240 · pop 160 · exit 140 · turn · spring · stagger; reduced motion stills all but hover; test reads shipped CSS | `transition: 'all .3s'` on Button; reduced motion in 2 sheets (`AFC/ui/modal/styles.css.ts:98`, one AI stream view) | literal [names] | `transition-all` ×148 (≈39 beside `duration-300`) [read grep] | 38 animated icons ignore reduced motion [docs] | mixins carry reduced motion [docs] | per-utility reduced motion [docs] | none [docs] | `motion.ts` reduced-motion aware | M blanket `*` kills hover guard; T none [docs] |
| Density | table 32/44/56 + 36 header; Button 28/32/36; IconButton 24/28/32; inspector 13/18 | button 28/32/40 | ButtonSmall/Large [names] | chrome × size variants [docs] | dialog/sheet sm/md/lg [docs] | height tokens 8–… | one `CONTROL_SIZE_VARIANTS` 24/32/36 shared by Button, Badge | ad hoc ("// why?") [docs] | controls 24/28/32; rows 48/40/72 [docs] | M 30px nav; T `min-h-7` rows |
| Contrast, high contrast | AA test: 25 pairs per theme (`src/styles/contrast.test.ts:28-49`): 6 action, 3 semantic 700-on-50, 16 text role × surface; no neutral/brand raw-step ink, composite or control pairs; no contrast mode | none | custom-accent warning [docs] | light-contrast + dark-contrast themes (`PL/packages/constants/src/themes.ts:7`) | generator + drift test (`AP/packages/web/test/styles/status-scales.test.ts`) | sticky-text picker only | lightness-delta guard [docs] | none; text scale ≤1.0 [docs] | `textOn` for accent marks [docs] | none |

**Computed, Cerebro tokens [calc]:**
- Opaque washes vary by ground: `n-50` over white 1.09:1, over `n-25` 1.04, over `--surface-sunken` 1.00, over `--surface-navigation` 1.02. A 5% ink layer is 1.10:1 on every light ground (1.15 dark). Translucent layers fix uneven visibility, not magnitude.
- Dark `--surface-selected` vs app ground 1.02:1, below hover `n-50` at 1.15:1: selection reads by hue only. Light: 1.13 vs 1.09.
- Dark `--surface-raised` (n-100) vs app 1.29:1; the overlays don't use it (they fill `--n-0`).
- Controls: Switch off track (n-300) 1.62:1 light; on track (cortex-500) 2.74:1 dark; Input/secondary border 1.62:1; Select keyboard-active row (`n-50`, no outline under `aria-activedescendant`) 1.09/1.15:1.

## Styling technology and theming

| Approach | Repos | Buys | Costs | For Cerebro |
| --- | --- | --- | --- | --- |
| CSS custom properties + Tailwind v4 `@theme` | Cerebro, Activepieces, Plane, Macro, Tolaria | Zero runtime. One attribute re-points everything. Cerebro's reset makes off-DS classes compile to nothing (`src/styles/index.css:17-30`) | Utilities name ramps, not roles (3,266). Arbitrary values escape (364 px classes). Stock namespaces not reset still ship: Tailwind 4.3.3 resolves `shadow-<name>` from its own theme and inlines it (`node_modules/tailwindcss/dist/lib.js`) [read], so 19 `shadow-sm/lg` uses ignore the DS and dark tokens (effect inferred, not run) | Keep. Add roles, reset `--shadow-*`, add rails |
| vanilla-extract | AFFiNE (416 files) | Typed build-time CSS; `createVar` gives vars-only variants (`AFC/ui/button/button.css.ts:7-22,89-164`) | Build plugin; two token generations live side by side; the Lit half can't use it | Take vars-only variants as plain CSS |
| styled-components | Outline (302 files) | JS theme builders, prop-driven | Runtime CSS-in-JS; a JS theme is a second decider beside `data-theme`; React-only | Avoid |
| Lit + shared CSS vars | AFFiNE blocksuite (558 files) | Tokens cross frameworks | Duplicate primitives (tooltip, toast, date picker exist twice) | Avoid a second set; BlockNote keeps `--bn-*` mapped to DS tokens |
| SCSS mixins → CSS vars | n8n | Light/dark mixins; stylelint name grammar | Legacy fallbacks; two Select generations | Take naming discipline only |
| Figma JSON → codegen (Flutter) | AppFlowy | One export feeds roles | New layer stalled with no rail (4 vs 136) | Lesson: ratchet |
| Plain CSS vars | Morrow, Thought Desk | Simple | No guard; literal z and sizes | n/a |

**Custom themes:** AFFiNE writes any var inline on `<html>` behind a flag, with no contrast check (`AF/packages/frontend/core/src/desktop/pages/root/custom-theme/index.tsx`) [read]. Plane builds ramps from 2 seeds and reloads [docs], but also ships high-contrast themes [read]. Macro derives semantics from 25 inputs (ThemeV3) [docs]. Activepieces seeds a contrast-adjusted generator, held by a drift test [read]. Outline warns on a custom accent [docs]. TD has 6 palettes plus OKLCH custom [read]; Morrow has 8 accents plus vault CSS [docs]. Tolaria removed vault themes over WKWebView reflow cost [docs]. Verdict: none for Cerebro (UX-01; synapse means AI, so a violet accent reads as AI). If ever reopened: derive from few inputs (Macro), contrast-generate (Activepieces), apply by data attribute, never by inline writes.

**Evolve without a rewrite (order):**
1. Rails first: CSS-variable definer test (DS-01) and the raw-step pair table (DS-02).
2. Tokens: z roles with no visual change (DS-05, landing with DS-03 in M94.5). Reset Tailwind's `--shadow-*` namespace as `--color-*` is reset, and migrate the 19 stock + 5 literal sites in the same change, which is visible, so capture both themes (DS-06 a). Shadow role names (the M16.36 rename, `src/styles/tokens/typography.css:5-27`) wait for the role layer: 68 `var(--shadow-*)` refs in 59 files (DS-06 b).
3. Owner-gated role layer: state layers, overlay surface, ink/line utilities (DS-07–09).
4. Move the 7 primitives that inject CSS strings at import (Button, IconButton, Input, Dialog, SegmentedControl, Switch, Tag) into colocated stylesheets, the way `src/components/ai/*.css` already work, with component-scoped vars (DS-10).
5. New primitives use the AI layer's `data-slot` + `render` idiom (`src/components/ai/renderPart.ts`, MIT port).

**Do not take (cut):**

| Item | Where | Why |
| --- | --- | --- |
| Wholesale Radix/vaul/sonner/kbar | AFFiNE, Outline, Activepieces | Would discard `layers.ts`, ghost exits and key claims. AFFiNE's own workarounds: `modal: true // false will case bug` [docs] |
| vanilla-extract, styled-components, Lit | AFFiNE, Outline | See table |
| Storybook dependency | AFFiNE (34 stories, no CI job), n8n (122 stories, Chromatic non-gating) | The lab renders real primitives over the mock; add a specimen mode instead |
| Theme editor, custom themes, accents, vault CSS | AFFiNE, Plane, Macro, TD, Morrow | UX-01. Vault CSS could restyle approval cards (CV-28/32) |
| Glass and frosted materials | Macro, TD | GPU cost in WKWebView; quiet identity |
| Hidden or custom scrollbars | AFFiNE (`* {scrollbar-width:none}`), Macro (`Scroll.tsx`) | Cerebro already styles visible 10px `::-webkit-scrollbar` rules on tokens (`src/styles/tokens/base.css:52-70`), not native overlay bars; keep those; never hide them globally or add a JS scroller (two local hides exist: the rail, `src/app/shell.css:17`, and the ViewTabs strip, M94B-A16) |
| `corner-shape: superellipse` | Outline, TD | Chromium only; nothing in WKWebView |
| `content-visibility` rows | TD | Chromium's AX tree dropped an offscreen row, so M84–M90 removed it (`plans/2026-10-17-m84-m90-implementation-record.md:95-98`); REL-08 bars its return |
| Notification center with counts | AFFiNE, Outline | Home is pull-only (M64.4) |
| Blanket reduced motion; `transition: all` | Morrow; AFFiNE Button, Plane `transition-all` ×148 | Kills the 20ms hover guard; animates unchosen properties |
| Half-pixel UI sizes, 10px text, text-scale clamp | Morrow, Tolaria, AppFlowy | Integer pairs; M94.9 needs real 200% zoom |
| Positive `tabIndex` registry | Plane | WCAG anti-pattern |
| Global `user-select: none` | Macro | Paths, ids and errors stay copyable |
| Autofocused destructive confirm; Escape commits an inline edit | AFFiNE, Outline, Morrow; AFFiNE `InlineEdit` | CV-37/39 Trash + Undo; CV-25 Escape writes nothing |
| Colours named after components | AppFlowy legacy, Outline (`sidebarHoverBackground`) | Role names only |

## Component inventory

Cerebro paths are under `src/`. "Others" lists which of the other 8 have it, [names] from file probes unless noted.

| # | Component | Cerebro | AFFiNE | Outline | Others | Verdict → rec |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Button, loading | `components/ui/Button.tsx` 4 variants × 28/32/36; no pending | Y `loading` swallows clicks (`AFC/ui/button/button.tsx:149-151`) [read] | Y `ActionButton` disables while its promise runs [read] | PLN, APC (drops label) | gap → DS-12 |
| 2 | IconButton | `components/ui/IconButton.tsx`, label mandatory | Y (label optional) | Y `NudeButton` | N8N, MAC, APC, TOL | ahead |
| 3 | SplitButton | - | - | Y `primitives/SplitButton.tsx` | N8N, MAC | no consumer; skip |
| 4 | Menu | `components/ui/Menu.tsx`: surface, item, separator, label, back; arrows, Home/End | Y (typeahead) | Y | all | typeahead, keycap column → DS-18 |
| 5 | ContextMenu | `components/ui/ContextMenu.tsx`: separate; no layer; z-50; literal shadow; flat items | Y same item, context host | Y `variant="context"` (`O/app/components/primitives/Menu/MenuContext.tsx`) [read] | PLN, APC, N8N, MAC, TOL | **P0** → DS-03 |
| 6 | Nested submenu | `MenuItem submenu` + `MenuBack` drill-in | Y `MenuSub` | Y | PLN, APC, TOL | ok; ContextMenu lacks → DS-03 |
| 7 | Select | `components/ui/Select.tsx`, the only select (CV-63); typeahead; `searchable` | ~ menu as select | Y `InputSelect`, label required | PLN (80 tests), APC, N8N (2 generations), MAC, TOL | ahead; name optional, active row 1.09:1 → DS-11 |
| 8 | Combobox | `Select searchable`; `app/QuickOpen.tsx` | ~ cmdk | ~ kbar | APC, N8N, TOL | already-have |
| 9 | Popover | `components/ui/Popover.tsx`: portal, flip, layer, `ANCHOR_MOVED_EVENT`, CSS-zoom geometry | Y Radix | Y Radix | all | ahead |
| 10 | Tooltip | `components/ui/Tooltip.tsx`: `aria-describedby`, works on disabled, catalog keycaps, warm-up | Y `shortcut` prop | Y skip-delay | all | ahead |
| 11 | HoverCard, preview | `components/ui/HoverCard.tsx` + `components/PagePreview.tsx` | - (click peek only) | Y `HoverPreview` | N8N, MAC, APC | ahead |
| 12 | Dialog sizes | `components/ui/Dialog.tsx` `width?: number` (10 widths), `fullscreen` | ~ width var | ~ `Modal` | AFY S/M/L 400/560/720 (`AFUI/lib/src/component/modal/dimension.dart`) [read]; APC sm/md/lg; N8N | gap → DS-12 |
| 13 | ConfirmDialog | - (Trash + Undo, CV-37/39) | Y, autofocuses destructive | Y, autofocuses danger | PLN (busy veto), N8N, MAC, TDK | keep absence; danger + pending on `DialogAction` → DS-12 |
| 14 | Drawer, sheet | `components/ui/DrawerScrim.tsx` | Y (mobile) | Y vaul | APC, MAC, TDK | already-have |
| 15 | Toast: tone, keyed, update in place | `components/ui/Toast.tsx` 5 tones; `app/ToastHost.tsx` neutral only, no key | Y, no live region [read] | Y sonner `toast.loading` → `toast.success` by id (`O/app/stores/UiStore.ts:493-504`) [read] | PLN promise settle; MOR tones, errors 8s (`M/src/app/ui.ts:36,110`) [read]; APC | gap → DS-14 |
| 16 | Notification center | - (Home, Review hold durable attention) | Y | Y server inbox | MAC | avoid |
| 17 | Command palette | `app/QuickOpen.tsx`: categories, choosers, Ask, catalog | Y cmdk | Y kbar | APC, N8N, MAC, MOR, TDK, TOL, AFY, PLN | ahead |
| 18 | Tabs | - (7 hand-built `role="tablist"`) | Y | Y | APC, TOL, N8N, MAC, PLN | gap → DS-15 |
| 19 | SegmentedControl | `components/ui/SegmentedControl.tsx`, sliding pill | ~ radio | - | N8N, MAC, TDK, MOR | ahead |
| 20 | Switch | `components/ui/Switch.tsx` (17 users, no test) | Y | Y | N8N, MAC, APC, TOL, TDK | track contrast → DS-11 |
| 21 | Checkbox | - (15 raw, 3 looks) | Y native input + icon in a `role=checkbox` div, sibling `<label htmlFor>`, indeterminate (`AFC/ui/checkbox/checkbox.tsx:66-90`) | ~ `SelectionCheckbox` | APC, TOL, N8N, MAC, MOR global skin | gap → DS-15 |
| 22 | Radio | - (4 raw) | Y | ~ raw | APC, N8N, MAC | low; DS-15 when a consumer needs it |
| 23 | Slider | - | Y | - | APC, N8N, MAC | no consumer |
| 24 | Input | `components/ui/Input.tsx`; no `onEnter`; 32 hand-rolled IME guard lines in 22 files, 8 of them (7 files) also test `keyCode 229` | Y `RowInput` IME-safe Enter | Y | all | **P0** IME guard in M94.4's three creation entries → DS-15(b), G19 |
| 25 | Textarea | - (20 raw) | - | - | APC, TOL | gap → DS-15 |
| 26 | DatePicker | `components/ui/DatePicker.tsx` + `Calendar.tsx` | Y | - | APC, N8N, MAC, AFY | already-have (literal shadow → DS-06) |
| 27 | Icon or emoji picker | `components/ui/IconPicker.tsx` (lucide, cap 96); `detail/PageChrome.tsx` (40 emoji) | Y emoji + icons, recents | Y | PLN, N8N, AFY, MOR, TDK | already-have |
| 28 | ColorPicker | local `ColorPicker` in `detail/OptionListEditor.tsx` (stores names) | ~ | Y `InputColor`, contrast warned | APC, N8N, MAC, TDK, AFY | already-have |
| 29 | Avatar, facepile | `components/ui/Avatar.tsx` + `AvatarGroup` | Y / - | Y `Avatar`, `Facepile` | N8N `UserStack`, MAC, APC | already-have |
| 30 | Badge | `components/ai/Badge.tsx` only | - | Y | PLN, APC, N8N, MAC, TOL | low → DS-30 |
| 31 | Tag, chip | `components/ui/Tag.tsx` (0 importers); `views/FieldChip.tsx`, `views/FilterChips.tsx` | Y | Y `DocumentChip` | N8N, MAC, APC, TDK, AFY | dead primitive → DS-31 |
| 32 | Property row | `detail/PropertyRow.tsx`; inspector 100px label grid | Y counted Show all | - | AFY, TOL `fit-content` grid, TDK | already-have |
| 33 | Data table, grid | `views/TableView.tsx` full render + load limit; `sheet/SheetGrid.tsx` windowed | Y virtual table behind a flag [docs] | Y `Table.tsx` window virtualizer [read] | APC optional; N8N `RecycleScroller` (no set size); PLN empty placeholders; MAC full + `aria-rowcount` | M93.7 owns; keep the access gate |
| 34 | List row, multi-select | `hooks/useListCursor.ts`, `components/ListSelectionBar.tsx` (Copy links only) | Y range select | Y `ModelSelection` + bulk bar | APC, N8N `SelectableList`, MAC | M94B-A30 |
| 35 | ARIA tree | `workspace/RootTree.tsx` only; `components/FileTree.tsx`, `app/CollectionTree.tsx` are button lists | - (mobile only) | - | MOR, TDK, N8N `Tree` v2, MAC [read grep] | gap → DS-22 |
| 36 | Breadcrumb | `components/PageToolbar.tsx` `Crumb`; `workspace/Breadcrumb.tsx`; no collapse | - | Y | PLN, APC, N8N, MAC, AFY, TDK, TOL | M94A-A14 |
| 37 | Resize panel | `components/ui/ResizeHandle.tsx`: keyboard separator, Escape abandons | Y, mouse only | Y `useResizeHandle` | APC, N8N, MAC; TOL, MOR, PLN mouse only [docs] | ahead |
| 38 | Split view | `engine/panes.ts`, `app/PaneRow.tsx` (≤4 panes, CV-52) | Y | Y `SplitView` | MAC, TDK | ahead |
| 39 | Scroll area | styled native scrollbars (`styles/tokens/base.css`); `components/ai/MessageScroller.tsx` | Y Radix, native hidden | Y `Scrollable` edge shadows | APC, TOL, N8N, MAC custom | keep native |
| 40 | Skeleton | - (`StateMessage` loading = icon + line) | Y + per-surface | Y `PlaceholderText` + `DelayedMount` 250ms [read] | PLN, APC, MAC 150ms + `role=status` [read], TOL | gap → DS-13 |
| 41 | Empty state | `components/ui/EmptyState.tsx` (25, untyped) + `StateMessage.tsx` (26, typed) | Y | Y `Empty` | PLN (5+ variants), APC, N8N, MAC, TDK | rule → DS-17 |
| 42 | Error state, boundary | `StateMessage unavailable`; 0 boundaries; 53 hand-rolled unavailable | Y (15 files) | Y `ErrorBoundary` (11 seams) | PLN, APC, MOR, TOL | **P0** → M93-N01 (DS-04 confirms the fallback) |
| 43 | Progress | - (AI `Context` ring is decoration; 5 `animate-spin`) | Y | Y `CircularProgressBar` | APC, PLN, N8N, MAC | no need yet |
| 44 | Keycap, shortcut hint | `components/ui/Keycaps.tsx`, from the command catalog | Y `shortcut` prop | Y; help hand-typed | N8N, APC, MAC, MOR, TDK | ahead |
| 45 | Status dot | - (`components/ui/StatusFlag.tsx` 0 importers) | - | - | N8N, APC, PLN group glyph, TOL save dots | → DS-31 |
| 46 | Card, Item | `components/PageCard.tsx`; MIT `components/ai/Item.tsx` (1 app importer) | Y | Y `DocumentCard`, `List/Item` | MAC `Item`, APC, N8N, TOL, PLN | promote → DS-30 |

> **2026-10-27 (Codex cross-check, CX-MAC-11):** `Item` now has 4 importers: three in `src/agent/` and `src/components/ai/Confirmation.tsx` (grep 2026-10-27).

| # | Component | Cerebro | AFFiNE | Outline | Others | Verdict → rec |
| --- | --- | --- | --- | --- | --- | --- |
| 47 | Drag handle | `components/ui/Grip.tsx`, `BlockDrag.tsx` (measured grammar) | Y + blocked drop indicator | Y | PLN, APC, N8N | ahead; blocked hint M94B-A08 |
| 48 | Settings kit | page-local `SettingRow` (`pages/SettingsPage.tsx:50-71`), no `aria-describedby` | Y `components/setting-components` | Y `scenes/Settings/components/SettingRow.tsx` | N8N 720px layout (`DS/components/N8nSettingsLayout/SettingsLayout.vue:58`) [read]; APC `role=group` + `aria-describedby` (`APW/app/components/admin/settings-panel.tsx:76-78`) [read]; AFY, MAC, TDK | gap → DS-16 |

## Conventions that work

| Convention | What works (repos) | Cerebro today | Verdict |
| --- | --- | --- | --- |
| Variant and size API | `[data-variant]`/`[data-size]` set vars only; base rule reads them (AFFiNE). Shared size map across Button and Badge (Macro). Primitive owns the state → token map (AppFlowy). `cva` + `data-slot/variant/size` (Activepieces) | String unions → class names + injected CSS. Call sites re-skin state by state (`src/detail/inspector.css:142-160`). `pageToolbar.css:86-92` wins with "two classes … wherever that loads". `md` is 32px on Button, 28px on IconButton | Vars-only variants + `quiet` (DS-10); size names (DS-25) |
| Slots, composition | shadcn `data-slot` + `render`/asChild (Activepieces, Cerebro AI layer); Macro `Item` slots; Plane `render` grafting | AI layer already does it; `components/ui` is props-only | New primitives use the AI idiom |
| Controlled state | Plane's id-first Select keeps unresolved ids; n8n instant vs reviewed save modes | Controlled Select, Dialog, Popover; drafts live outside components (`creationDraftStore`, `DocumentOwner`) | already-have; `pending` stays render-only |
| Portals, layers | Two global z tokens + local 0–5 (AFFiNE); one depth table (Outline); bands + "wrap a family in one token" (Macro); boot-injected table (n8n) | `layers.ts` (kinds, `modal`, `contains`, nested outside-press) is ahead. No z names; ContextMenu outside the stack; `RelationPicker` draws its own scrim at z 1000/1001 | DS-03, DS-05 |
| Focus, keyboard | Radix typeahead (AFFiNE, Outline); widget-role stand-down (`O/app/utils/isKeyboardWidget.ts`); ARIA tree with F2/Delete/menu key (Morrow) | One capture keymap, claims, layers own Escape, `useFocusRestore`, Tab traps. Gaps: menu typeahead, trees, ContextMenu, a 1.09:1 active-row cue in Select | DS-03, DS-11, DS-18, DS-22 |
| Reduced motion | Mixins carry it (n8n); per-utility blocks (Macro). Weak: AFFiNE 2 sheets, Activepieces 38 icons, Morrow blanket, Tolaria/AppFlowy none | Tokens collapse all but hover; test reads shipped bytes; every e2e spec runs reduced | ahead; Skeleton must be static |
| Docs, specimens | Executable gallery: globbed `*.docs.tsx`, a test renders every demo, a coverage page lists gaps (Macro `MAC/src/features/ui-gallery/`). Storybook without CI decays (AFFiNE 34 stories, 3 specs). Human-reviewed, non-gating diffs (n8n Chromatic) | State lab: 34 sections × 5 states; `CompositionLab` for widths; no primitive matrix (`src/lab/main.tsx:6-10`) | DS-19 |
| Adoption ratchets, lint rails | Compiler-backed class + var lint (Activepieces `check-tailwind-classes.mjs`) [read]; ast-grep rules where error = 0 violations, warn = burn-down, plus an AST audit (Macro); stylelint name grammar (n8n). Failures: AppFlowy no rail; Plane 11,957-warning budget; Tolaria prose-only rules | `theme.test.ts` (colour, radius, size), CV-61/63 element rails, CV-64 AST boundary, keydown rail. No var, shadow, z, hover or adoption counts | DS-01, DS-20 |
| Contrast tests | Generator + drift test across 432 seeds (Activepieces); high-contrast themes (Plane) | Role pairs, AA, both themes; nothing for raw steps, composites or controls | DS-02, DS-11, DS-23 |

## Where Cerebro's design system is ahead (keep)

1. **Off-DS classes compile to nothing, and a test fails** (`src/styles/index.css:17-30`, `src/styles/theme.test.ts`). Macro does the same for colour: `--color-*: initial` (`MAC/src/index.css:376`) plus an error-level ast-grep rule (`macro-main/rules/ast-grep/tsx-no-raw-tailwind-palette.yml`); Cerebro's reset also covers radius, text and leading. Activepieces' compiler lint is the other near match.
2. **AA gate in both themes** (`src/styles/contrast.test.ts`). AFFiNE, Morrow, Tolaria, AppFlowy and n8n have none; Macro's is a lightness delta.
3. **Motion as data:** kind pairs, reduced motion that keeps the 20ms hover guard, a test over shipped CSS, `Presence`/`leaveGhost` exits (`src/styles/tokens/spacing.css:46-130`, `src/components/ui/motion.ts`). 0 `transition-all`, vs Plane ×148 and AFFiNE's `all .3s`.
4. **Explicit layer stack** (`src/components/ui/layers.ts`): Escape ownership, `modal` stand-down, portalled `contains`. AFFiNE fights Radix instead.
5. **One keymap feeds tooltips, keycaps, ⌘K and Settings.** Outline hand-types 74 shortcut rows.
6. **Five read states plus the lab** (`StateMessage`, `src/lab/presets.ts`, 34 sections). Outline (10 of 13 lists) and Activepieces (a failed diff) collapse failure into empty.
7. **Element rails:** Select everywhere (CV-63), images (CV-61), AST boundary for AI elements (CV-64). Tolaria's and Plane's rules are prose.
8. **Container-first composition:** 2 viewport variants vs 32 container variants + 17 `@container` rules. Plane has `md:` ×187; n8n 68 `@media` vs 12 `@container`.
9. **Per-primitive tests:** 61 files (22/28 ui, 31/31 ai). AFFiNE has 3 specs, Outline 0 `.test.tsx`, Tolaria 3.
10. **Theme by ramp re-pointing, one decider, pre-paint** (`src/styles/tokens/colors.css:205-231`, `src/hooks/useTheme.ts`, `index.html`). Tolaria converged on the same.
11. **Option triples with ink ≥4.5:1 on their pill** (`--opt-*-ink`). AppFlowy's badges are identical in both themes.
12. **Toast host:** an always-mounted polite region, paused on hover/focus (`src/app/ToastHost.tsx:76-77`). AFFiNE's toast has no live region [read].
13. **Accessible small primitives:** keyboard `ResizeHandle` (AFFiNE, Morrow, Plane resizers are mouse-only), mandatory IconButton label (optional in AFFiNE), Tooltip `aria-describedby` on disabled controls (absent in TD).
14. **Bundled variable fonts, integer size/leading pairs.** Tolaria's fonts are unbundled; Morrow uses half-pixel sizes.
15. **Table chrome hidden at rest with `visibility`** (`src/styles/table-chrome.css`): no layout shift, no invisible hit targets.

## Gaps, prioritized, each with proof

| # | Gap | Proof | Priority | Rec |
| --- | --- | --- | --- | --- |
| G1 | ContextMenu outside layers, z and menu primitives | Items are `{icon,label,danger,onSelect}`, no `disabled` (`src/components/ui/ContextMenu.tsx:6-11`), so M94.5's "disabled blockers at every entry point" cannot hold; `fixed z-50`, below the 1050 popover band, literal shadow (`:96`); 0 of 10 consumers register a layer [read]. `hasModalLayers()` stays false and the menu sets no `data-key-claim`, so `g p` and the `j`/`k` list rows run behind it (`src/lib/keys/root.ts:125-144`, `src/lib/keys/claims.ts:72-92`). Escape: the menu's own `stopPropagation` stops the bubble-phase owners (peek `src/detail/DetailPanel.tsx:173`, `Dialog.tsx:158`, `DrawerScrim.tsx:113`); only a capture-phase `useEscapeLayer` surface beneath, a `Popover` (`src/components/ui/Popover.tsx:81-109`), takes it first [traced, not run] | P0 | DS-03 |
| G2 | Undefined CSS variables | `--info-50/-700` defined nowhere (`src/knowledge/FacetChips.tsx:27`). `var(--danger,#b42318)` always paints the light-theme literal (`src/workspace/RootMountDialog.tsx:65`). The bug class is already recorded twice (`colors.css:42-55`, `src/status/ProposalCard.tsx:50`) | P0 | DS-01 |
| G3 | Raw-step ink fails AA | synapse-600/700 keep light values in dark: 2.22/1.70:1 at `src/sheet/SheetMenu.tsx:51`, `src/sheet/SheetAsk.tsx:65`, `src/editor/blocks.tsx:597`, `src/editor/editor.css:1116` [calc]. Light `text-n-400` 3.49:1 ×314 (the token is "disabled ink and icon strokes", `colors.css:9`, yet most sampled uses are text); `text-n-500` 4.35 (white) / 3.99 (`n-50`) ×443, including new M94.4 copy (`src/app/CreationDraftRecovery.tsx:22`, 12px). Select placeholder uses `--n-400`, bypassing the tested `--text-placeholder` role (`src/components/ui/select.css:103-105`) | P0 | DS-02 |
| G4 | No render containment | `getDerivedStateFromError\|componentDidCatch\|onUncaughtError` → 0 hits; bare `createRoot` (`src/main.tsx:15`) | P0 | M93-N01 (DS-04) |
| G5 | No state-layer role | 274 opaque washes; deltas 1.00–1.09:1 by ground [calc]; 7 ad hoc `color-mix` ink washes already chosen for dark correctness (matrix, State layers); ghost Button `n-50` vs IconButton `n-100` | P1 | DS-07, DS-10 |
| G6 | Overlays skip the raised surface; no role shadows | 7 overlays fill `--n-0` (= dark app ground): Menu, Select list, Dialog, HoverCard, Toast, DatePicker, ContextMenu, though `--surface-raised` already steps up in dark (`--n-100`, `src/styles/tokens/colors.css:336`) and floating ChordHint and AnchoredFieldStatus use it. 19 stock + 5 literal shadows | P1 | DS-06, DS-08 |
| G7 | No z roles | 17 values; the 1100 tie; order lives only in comments (`src/components/ui/Popover.tsx:435-443`, `Dialog.tsx:9`, `src/app/ToastHost.tsx:68`) | P1 | DS-05 |
| G8 | No ink/line role utilities | 3,266 raw vs 217 role refs; 148 hand-written `text-(--text-meta)` show the demand | P1 | DS-09 |
| G9 | Control states below 3:1 | Switch 1.62 (light off) / 2.74 (dark on); Select active row 1.09/1.15 with no outline [calc] | P1 | DS-11 |
| G10 | Primitive gaps M94.6–M94.8 will hand-roll again | No pending, Skeleton, Checkbox, Textarea, Tabs; 9 Dialog widths; toast without tone/key; page-local settings row; 53 hand-rolled unavailable | P1 | DS-12–17 |
| G11 | Menu rows thin | `MenuSurface` handles arrows/Home/End only (`src/components/ui/Menu.tsx:52-78`); no typeahead, keycap column or separator normalisation | P1 | DS-18 |
| G12 | Adoption unmeasured; no primitive specimen | Counts above exist only in this file; `src/lab/main.tsx` has 2 branches | P1 | DS-19, DS-20 |
| G13 | Sidebar trees not ARIA | `role="tree"` only in `src/workspace/RootTree.tsx` | P1 | DS-22 |
| G14 | Dark selection by hue only | 1.02:1 selected vs 1.15:1 hover [calc]; the comparison is already planned (VS10; M94.2 checkbox 4) | P2 | DS-24 |
| G15 | Size, type and radius escapes | IconButton/Segmented sizes are literals; 12 `text-[Npx]`, 30 CSS sizes, 28 radii | P2 | DS-25–27 |
| G16 | No contrast mode | no `prefers-contrast` in `src`; one decider (`src/hooks/useTheme.ts`) | P2 | DS-23 |
| G17 | Two menu families | `/`, `@`, `[` menus are BlockNote/Mantine lists (`src/editor/MarkdownEditor.tsx:1750-1830`) | P2 | DS-29 |
| G18 | Dead and drifted bits | `Tag`, `StatusFlag` 0 importers; Mermaid fallbacks drift from tokens (`src/mermaid/theme.ts:17,27-29,33-34`: 5 values at 6 sites, e.g. `--n-800` `#272d3b` vs `#2f3237`; fallbacks serve only stylesheet-less vitest, `theme.ts:6-8`) | P2 | DS-28 (→ DS-01), DS-31 |
| G19 | IME Enter guards differ; M94.4's miss WebKit | 32 hand-rolled guard lines in 22 files; 8 (7 files) also test `keyCode === 229`. The keymap, `ChatInput` and `PromptInput` test `isComposing \|\| keyCode === 229`, the Enter WebKit sends after `compositionend` (`src/lib/keys/root.ts:113`, `src/agent/ChatInput.tsx:677-680`, `src/components/ai/PromptInput.tsx:179-181`). The staged M94.4 creators test `isComposing` only (`src/app/CreateMenu.tsx:106,159`, `src/app/RecordComposer.tsx:109,169`; also the launcher's combobox, `src/app/CreateLauncher.tsx:101`, which starts the highlighted flow and writes nothing), and the unit case covers only `isComposing: true` (`src/app/RecordComposer.test.tsx:316-325`). Committing a CJK word with Enter in WKWebView can create the page or record (M94 Review Focus 2) [read; effect inferred from Cerebro's own WebKit note] | P0 | DS-15(b) |

## Recommendations

Licence: every row re-implements its idea in Cerebro's code unless it says port. Ports: DS-01 (Activepieces script, MIT, with notice), DS-15(a) (Morrow skin, Apache-2.0, with notice); DS-30 moves an existing MIT port.

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| DS-01 | CSS-variable definer rail (vitest): every `var(--x)` in CSS, `style` and arbitrary classes needs a CSS or TS definer; a fallback is no exemption; runtime-composed prefixes (`--bn-`, `--opt-`, `--swatch-`, `--canvas-`) allow-listed with reasons; a JS fallback literal must equal its `colors.css` light value (absorbs DS-28's 5 drifted Mermaid fallbacks). Fix `--info-*` and `--danger`; delete the dead `--floating-chat-available-height` hook or set it. Port (MIT, with notice) or re-implement. The class half can use `tailwindcss`'s `__unstable__loadDesignSystem` (exported in 4.3.3 `dist/lib.js`; unstable API). A lint rail like `theme.test.ts`, never styling proof (M94 Global Constraints bar class-name tests as proof). P0 because it must land before M94.2's token edits and any role layer add new var names, and it guards the CSS that concurrent M93–M99 work writes now; `var(--danger,#b42318)` reads 2.03:1 on dark `bg-n-50` [calc] | M94.2 (first step, before any token edit; M94.1 is evidence-only, "no source edits by default") | P0 | S | `AP/packages/web/scripts/check-tailwind-classes.mjs:52-60` [read]; scan result (Counts, cmd 11) [read] | APC-04, M94A-A01 |
| DS-02 | Pair-table contrast test: declared ink × ground pairs actually rendered (raw steps used as text, AI and link inks, which the test omits today, placeholder, opt pills, control boundaries), both themes. Rule: every raw step used in `src/` has a dark value or a stated theme-invariant reason. Fix now: dark synapse-600/700 (as M52.3 did for cortex-600, `colors.css:255-264`): 4 ink sites and no fill use them, so light is unchanged; capture both themes (M94.2 checkbox 4). M94A-A02's owner wait fits new `n-500` values, which this row does not change. Placeholder → `--text-placeholder`. Ratchet `text-n-400/500` text uses down; new code takes roles | M94.2 | P0 | S (test, fixes); ratchet ongoing | [calc] values in G3; current work repeats it (`src/app/CreationDraftRecovery.tsx:22`, M94.4) [read]; contrast test covers role pairs plus 3 semantic 700-on-50 pairs (`src/styles/contrast.test.ts:28-49`); Activepieces drift test (`AP/packages/web/test/styles/status-scales.test.ts`) [read] | APC-01/02, PLN-01, M94A-A02 |
| DS-03 | ContextMenu = `Popover` with a point anchor + `MenuSurface`/`MenuItem`/`MenuSeparator`. It registers a modal layer (keymap stands down, stack owns Escape, CV-47), sits in the popover band and uses the token shadow. Items gain `disabled` + visible reason, separator, `checked`, `submenu`. Keep `useFocusRestore` and the ghost exit. The shared `MenuItem` drops a disabled row from arrow stops on purpose (`src/components/ui/Menu.tsx:23-26`), so the reason must be visible row text, not only `title`. Tests: `g p` and `j` are inert while open; one Escape closes only a context menu opened over a `Popover` (docked-peek and drawer cases stay as regressions); a blocked row reads its reason. Amends M94.5's file map; P0 because M94.5 checkboxes 1 (disabled blockers at every entry point) and 4 (one Escape, foremost layer) cannot pass on today's menu | M94.5 | P0 | S | G1 [read; traced]; Outline `MenuProvider variant` [read]; AFFiNE one item in two hosts, Plane rows with reasons [docs] | AFN3-04, OUT3-03, PLN-05, M94B-A02 |
| DS-04 | **Confirm M93-N01; no separate DS work.** The fallback is the existing `StateMessage state="unavailable"` with its `action` slot holding Retry (remount by key) and Back (`src/components/ui/StateMessage.tsx:16-43`); no automatic Reload, and the top boundary's explicit Reload only when nothing memory-only is unresolved (M93-C01). M93 places the boundaries | M93.new-render-containment (owned by M93-N01) | P0 (M93-N01's) | none in the DS | 7 repos have boundaries (Outline, Plane, Tolaria, Activepieces, Morrow, AFFiNE, Macro's Solid `ErrorBoundary`) [read grep]; G4 [read] | OUT3-06, PLN-02, TOL-01, APC-14, MOR-04, M93-N01 |
| DS-05 | Named depth roles `--z-{sticky,drag-line,chord-hint,panel,drawer,scrim,dialog,popover,hovercard,tooltip,toast}` mapped to utilities. Values unchanged except the 1100 tie, split hover card < tooltip < toast. A rail refuses new page-scope raw z; local stacking uses `isolation: isolate`. Layer tests assert distinct bands | M94.5 with DS-03 (amend its file map: depth tokens + the z sites); no owner gate, no visual change but the tie split. M94.2's file map is composition-only; M94A-N01 (3) files it under ds-roles | P1 | S | Outline `depths.ts`, n8n `z-indexes.ts`, Macro `index.css:584-662`, AFFiNE 2 tokens + local 0–5, TD ladder [read]; Cerebro cmd 3 | OUT3-05, N8N-01, MAC-04, AFN3-05, TDK-20, M94A-N01 |
| DS-06 | (a) Reset `--shadow-*: initial` in `@theme inline`, as `--color-*` is (`src/styles/index.css:17-30`). The DS keeps its `:root` `--shadow-*` names, so the 48 `shadow-[var(--shadow-*)]` sites stay as they are. Migrate the 19 stock + 5 literal sites to them in the same change (visible: capture both themes, M94.2 checkbox 4). `theme.test.ts` refuses `shadow-[…rgba(` and stock `shadow-*`. (b) Role names (e.g. `--elev-raised/overlay/dialog`, the M16.36 rename) only inside `M94.new-ds-roles`: 68 `var(--shadow-*)` refs in 59 files is the "repository-wide CSS replacement" M94.2 rules out (checkbox 5). Elevation roles themselves are already planned (VS07 "shadow only for something floating", UX-03 "shadows for overlays" → M94.2–M94.3); this row adds the mechanism and the stock-namespace defect | (a) M94.2–M94.3 (VS07; amend the file map); (b) M94.new-ds-roles | P1 | S | `node_modules/tailwindcss/dist/lib.js` shadow utility reads theme `--shadow-<name>` and inlines it [read; effect inferred]; `src/styles/index.css:17-30` resets colour/radius/text/leading only [read]; cmd 6 | VS07 (planned), new defect (this audit), AFN3-03, PLN-08 |
| DS-07 | Translucent state layers `--state-hover` (≈5% ink) and `--state-press` (≈8–10%), tuned per theme, drawn by primitives (`::before` or `background-image`). `--surface-selected` stays an opaque role. Bind Button, IconButton, MenuItem, Select option, nav and tree rows, TabBar first; ratchet the 274 washes; contrast test composites each layer on each ground | M94.new-ds-roles (owner) | P1 | M | 6 repos translucent: AFFiNE `button.css.ts:44-62` (value unvendored; the layer paints over the label), Macro `index.css:266-276`, AppFlowy `Semantic.Light Mode.tokens.json` (Fill), Morrow `tokens.css:30-31`, n8n `_tokens.scss:14-15`, TD `app.css` `--fill*` [read]. Opaque: Activepieces rule, Tolaria, Outline light [read]. Uniform 1.10:1 vs 1.00–1.09 today [calc]. Cerebro already hand-writes 7 such washes for dark correctness (G5) [read] | AFN3-01, MAC-02, AFY-01/02, MOR-08, M94A-N01 |
| DS-08 | Overlays take the existing `--surface-raised` (light `--n-0`, dark `--n-100`, 1.29:1 over the app ground; `src/styles/tokens/colors.css:164,336`), already in the contrast test (`src/styles/contrast.test.ts:39`) and already used by floating ChordHint and AnchoredFieldStatus. New tokens only for the overlay border and shadow (DS-06 b). Point the 7 overlay sites at it with or after DS-07: their `hover:bg-n-50` and Select `[data-active]` rows (`#2e2f33`) would sit darker than an n-100 ground in dark. Matches M94A-N01 (2) | M94.new-ds-roles (owner, VS10) | P1 | S | AFFiNE overlayPanel Grey900 on Grey950 (`Colors.kt`); Morrow `--popover #282828` on `#191919`; TD elevated `#1c1c1e` on `#000`; Outline dark `menuBackground`; Plane overlay card `layer-2` + `shadow-overlay-200` [read]; G6 | AFN3-03, PLN-08, MAC-03, M94A-N01 |
| DS-09 | Ink and line role utilities (`text-ink-{primary,secondary,meta,disabled,placeholder,link,ai}`, `border-line-{subtle,strong,focus}`); raw ramps kept for swatches, options, avatars. Ratchet raw-ramp ink/line in `className`; new files take roles | M94.new-ds-roles (owner) | P1 | M | Plane 3,510 role vs 30 raw + written rules (`PL/packages/tailwind-config/AGENTS.md`) [read]; Cerebro 3,266 vs 217 (cmd 4) | PLN-01, M94A-N01 |
| DS-10 | Move the 7 injected-CSS primitives into colocated stylesheets; variants set component vars (`--btn-bg/fg/border/h`) and one base rule reads them; add `variant="quiet"`, which deletes `inspector.css:142-160` and the `pageToolbar.css:86-92` outrank. Retarget `src/styles/motion.test.ts:159-173`, which reads the injected Button, IconButton and SegmentedControl CSS, to the new files so the motion rail keeps them; `Tag` (0 importers) may go under DS-31 instead. Re-implement (AFFiNE idea, MIT) | M94.new-ds-roles (with DS-07) | P1 | M | `AFC/ui/button/button.css.ts:7-22,89-164` [read]; Cerebro `document.head.appendChild` in 7 files [read]; AI layer `--ai-badge-ink` precedent (`src/components/ai/foundation.css`) | AFN3-02, AFY-02 |
| DS-11 | Control-state fixes: Switch off track and dark on track ≥3:1; Select `[data-active]` gets an inset focus ring when keyboard-driven; checkbox box border ≥3:1; Input/secondary border fixed or declared an exception in the DS-02 table, as Owner decision 4 rules; visible, so capture both themes. Add behavioural tests for Switch, IconButton, Toast, EmptyState | M94.2 (fix); M94.9 (rendered measure) | P1 | S | [calc] G9; `src/components/ui/Switch.tsx` CSS, `select.css:166-168` [read] | new (this audit), AFN3-12 |
| DS-12 | `Button` and `DialogAction` `pending` (keeps its text label, `aria-busy`, ignores clicks; authority stays in stores/ACT; M94.4's "Creating…" stays the label), `DialogAction.variant: 'danger'`, and `Dialog size: 'sm'\|'md'\|'lg'` (400/560/720). The two 960px lightboxes (`src/components/FileLightbox.tsx`, `src/mermaid/MermaidLightbox.tsx`) need an `xl` or `fullscreen`; the other 21 sites move only under owner comparison (M94: no propagation before acceptance) | M94.new-primitive-gaps | P1 | S | AFFiNE `button.tsx:149-151`, Outline `ActionButton.tsx` [read]; AppFlowy `dimension.dart` [read]; Activepieces drops the label (avoid) [docs]; in-tree precedent `aria-busy` on the AI `Confirmation` (`src/components/ai/Confirmation.tsx:246`) [read]; cmd 7 | AFN3-10, OUT3-10, APC-09, AFY-04, PLN-12, M94B-A12, M94A-N02 |
| DS-13 | `Skeleton`: rows from `--nav-row-h` and the table's `ROW_HEIGHT` map (32/44/56, `src/views/tableAnatomy.tsx:127-131`; classes, not tokens), one `role=status` label, invisible for 150–250ms, static under reduced motion, first load only (a refresh keeps the last good content; a failed refresh marks it partial, never empty, CV-05). A transient journey state beside CV-44's five; per-layout skeletons for Pages, table and board in their phases. The requirement is planned (VS13 "loading preserves approximate geometry", UX-10 → M94.8); this is its mechanism | M94.new-primitive-gaps; consumers M94.6/M94.8 | P1 | M | 5 repos: Macro `ListSkeleton.tsx:7,12` [read], Outline `DelayedMount.ts:8` [read], AFFiNE `AFC/ui/skeleton/` [read], Plane, Tolaria [docs]; AFFiNE animates under reduced motion (avoid) | VS13 (planned), AFN3-09, OUT3-08, MAC-09, PLN-04, TOL-09, M94B-A24 |
| DS-14 | `toast(message, {tone, key, action})`: `key` updates one slot (working → done/failed); `danger` → `role=alert`, longer life; host passes the tone `Toast` already draws. Save failures stay in M93's retained status | M94.8 | P1 | S | Outline keyed `toast.loading/success` (`UiStore.ts:493-504`) [read]; Morrow tones, errors 8s (`ui.ts:36,110`) [read]; Cerebro `ToastItem` has no tone (`src/stores/uiStore.ts:589-606`) | OUT3-07, MOR-12, PLN-17, M94B-A25 |
| DS-15 | Form-control pack: (a) one checkbox look, either a global `appearance:none` skin (port Morrow, Apache-2.0, with notice, but box border ≥3:1, `:indeterminate`, `:focus-visible`; exclude Switch's input) or a primitive, plus a CV-63-style rail (a new CV id whose `enforced:` pointer `scripts/conventions.test.ts` resolves); current work keeps adding raw ones (`src/history/RecoverySettings.tsx:89`, `src/app/CreateMenu.tsx:175`, `src/app/RecordComposer.tsx:304`); (b) **now, in M94.4:** one shared `isImeEnter(e)` = `isComposing \|\| keyCode === 229`, the keymap's own rule (`src/lib/keys/root.ts:113`), in `CreateMenu`, `RecordComposer` and `CreateLauncher` (`:101`; all three are in M94.4's file map), plus a unit case with `keyCode: 229, isComposing: false`; later `Input onEnter` uses it; (c) `Textarea` for the 20 raw; (d) a headless `useTabList` (roving focus, arrows) for the 7 tablists (6 app files + `SegmentedControl`) | (b) M94.4; (a, c, d) M94.new-primitive-gaps | P0 (b); P1 (a, c, d) | S (b); M | G19 [read]; `M/src/app/styles/app.css:1079-1113` [read] (its `--border-strong` box is too faint to copy); `AFC/ui/checkbox/checkbox.tsx`, `AFC/ui/input/row-input.tsx` [docs]; cmd 9 | MOR-06, AFN3-11/12, M94B-A09, M94A-N02 |
| DS-16 | Utility kit `UtilitySection`/`UtilityRow`: label, hint linked by `aria-describedby`, control, field status, `role=group`; grouped rows with inset separators; rhythm owned by the following sibling. An optional SaveBar for multi-field drafts only (CV-25 per-row Done stays). Settings is the first consumer. The utility order and top/bottom insets are already drawn (UX-02; `composition-sheet.md` Utility row and repair specimen); new here: the row primitive, its ARIA and row numbers | M94.2 (row numbers in the sheet); M94.8 (build, adopt) | P1 | M | n8n `SettingsLayout.vue:58` 720px [read]; Activepieces `settings-panel.tsx:76-78` [read]; AFFiNE, Outline, AppFlowy, Macro, TD kits [names]; `src/pages/SettingsPage.tsx:50-71` [read] | APC-07, N8N-02/03, AFY-08, TDK-06, M94A-A05 |

> **2026-10-27 (Codex cross-check, CX-AFY-07):** `src/pages/SettingsPage.tsx:374` now renders `PageHeader composition="utility"` (uncommitted). `SettingRow` is still page-local (`:53-74`, was `:50-71`), with no `aria-describedby` and no Reset; the kit is unbuilt.

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| DS-17 | Grow `StateMessage`'s existing `ReadState` (`src/components/ui/StateMessage.tsx:4`) into a data-carrying `Read<T>` + `ReadView` with every branch a required prop; fold in the local copies (`type Read<T>` in `src/status/AgentRoster.tsx:76`, `src/status/AgentRunHistory.tsx:16`, `src/app/MailSettings.tsx:15`; `LedgerRead`, `TrashRead`; M94.8's `ConnectorInventory`, already in the tree at `src/library/AgentProperties.tsx:51`) rather than invent one. `EmptyState` only for a true empty; ratchet the 53 hand-rolled unavailable markers and the 2 EmptyState-as-failure sites (`src/workspace/FileViewer.tsx:114`, `src/pages/DiagramPage.tsx:101-108`) | M94.8 | P1 | M | Activepieces `DataTable` requires `isError` [docs]; cmd 8 [read]; local unions [read] | APC-05, N8N-11, M94B-A22 |
| DS-18 | Menu rows: typeahead in `MenuSurface`, a shared icon column, separator collapse. Already planned in M94.5 (checkbox 1; UX-06, PJ08): shared labels, availability and disabled blockers. Keycaps come with M94B-A01's proposed `menuItemsFor` adapter, not the plan. This row adds only the three row mechanics | M94.5 | P1 | M | Outline `Menu/transformer.tsx` normalisation [docs]; Radix typeahead (AFFiNE) [docs]; `src/components/ui/Menu.tsx:52-78` [read] | OUT3-02, AFN3-23, PLN-05, M94B-A01 |
| DS-19 | `state-lab.html?specimen=<primitive>`: variant × size × state (rest, hover, focus, disabled, pending, danger) × theme (+ reduced motion) for Button, IconButton, Menu, ContextMenu, Select, Dialog sizes, Toast tones, StateMessage, Skeleton, Switch, Checkbox. One vitest renders all in both themes. Captures are component evidence, never journey or aesthetic acceptance. No Storybook. It is the instrument for VS07's planned "screenshot montage of menus, field popovers, cards, dialog" (M94.2–M94.3), which has none today | M94.2 → M94.9 | P1 | S–M | Macro gallery + render test + coverage page [names]; AFFiNE 34 stories, 3 specs [read count]; n8n 122 stories, Chromatic non-gating [read count, docs] | AFN3-08, MAC-06, N8N-18, M94A-A11 |
| DS-20 | Down-only `scripts/ds-adoption.test.ts` with committed baselines from the Counts table (raw `<button>`, `hover:bg-n-*`, raw z, off-token shadows, Dialog widths, hand-rolled unavailable, raw checkbox/textarea, raw-ramp refs, `text-n-400/500`, `text-[Npx]`). M94.9 records them; each M94.6–M94.8 commit lowers its count (CV-12). A source rail like `theme.test.ts`, never visual evidence: M94's Global Constraints bar class-name tests as proof of a change. One definition for the merged ratchet: app code only (no tests, no `src/lab/`, not `StateMessage` itself), so `section-unavailable` is 55 in 41 files today; M94B-A18's 92 in 74 counts the lab's fixtures | M94.2 + M94.9 | P1 | S | AppFlowy 4 vs 136 [docs]; Macro `scripts/ui-audit.ts` [read]; Plane shims with call-site counts [docs] | AFY-03, MAC-07, PLN-13, M94A-A12, M94B-A18 |
| DS-21 | Once roles are accepted, publish them as a dev skill (`.claude/skills/ui-roles/SKILL.md`, listed in AGENTS.md's Dev skills per CV-17, which `scripts/dev-skills.test.ts` checks, at most 80 lines that point at sources, its `BODY_MAX_LINES`); each rule names its rail | M94.2, after the owner accepts the sheet (and M94.new-ds-roles, if approved) | P1 | S | Plane `AGENTS.md`, n8n design-language doc, Activepieces `AGENTS.md` [docs]; fresh M94.4 code chose `text-n-500` (`src/app/CreationDraftRecovery.tsx:22`) [read] | PLN-01, N8N-12, M94A-A13 |

> **2026-10-27 (Codex cross-check, status-drift D7, N1):** The 2026-10-25 composition decision accepted insets and alignment only (`specs/2026-10-25-m94-refined-composition-decision.md:7`); DS roles (state layers, `n-400/500`) are still undecided, so this row still waits.

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| DS-22 | Folders and Collections as ARIA trees on `RootTree`/`treeRows.ts`: roving tabindex, arrows; F2 (through `renameActions`, CV-41), Delete (to Trash, CV-37), menu key as tree-scoped command rows (CV-47); row actions `tabIndex=-1`. Amends M94.5's file map (`src/components/FileTree.tsx`, `src/app/CollectionTree.tsx`, `src/workspace/{RootTree.tsx,treeRows.ts}`): the keys are command rows that M94.5's registry audit owns, and M94.3 keeps the sidebar rhythm only (M94A-A09) | M94.5 + M94.9 | P1 | M | Morrow, TD, n8n `Tree` v2, Macro [read grep]; `src/workspace/RootTree.tsx` [read] | MOR-01, M94A-A09 |
| DS-23 | Contrast mode: `useTheme` and the pre-paint script resolve `prefers-contrast: more` into `data-contrast="more"`; one block re-points ramps, borders, focus and state layers in both themes; the contrast test covers it. No custom themes | M94.new-contrast-theme (owner) | P2 | M | Plane high-contrast themes [read]; no reference uses `prefers-contrast` [read grep] | PLN-07, M94A-N04 |
| DS-24 | **Confirm (planned):** M94.2 checkbox 4 already inspects "selection, hover" in both themes and VS10 requires "selection remains distinct from hover" (M94.2–M94.3). Input to that comparison and Owner decision 3: dark selected 1.02:1 vs hover 1.15:1; a candidate ≈1.19:1 step | M94.2–M94.3 (VS10) | P2 | S | [calc] G14; AppFlowy select 15% vs hover 5%, Macro 8–16% vs 3% [read] | VS10 (planned), AFY-01, MAC-02 |
| DS-25 | Size vocabulary: add `--control-h-xs: 24px`; IconButton, SegmentedControl and Tag (only if DS-31 keeps it) read `--control-h-*`. Heights unchanged (plan constraint). Same injected-CSS files as DS-10 (IconButton's px map is TSX, `src/components/ui/IconButton.tsx:67`), and M94.2's file map lists no primitive | With DS-10, or `M94.new-primitive-gaps` as M94A-N02 (7) files it | P2 | S | Macro `controlSizes.ts` [read]; `src/components/ui/IconButton.tsx` px literals [read] | MAC-08 |
| DS-26 | Extend the size rail (`src/styles/theme.test.ts:78-93`, which skips arbitrary values) to `text-[Npx]`. The exception inventory itself is planned (VS04 "document legitimate exceptions and remove accidental ones" → M94.2–M94.3). Compare a dark weight trim (400 floor) and `text-wrap: balance` on titles (check the editable H1 caret in WebKit; M94A-A14) | M94.3 | P2 | S | TD `app.css:76-84,181-186` (dark trim, 400 floor), `1046,1076` [read]; cmd 12 | VS04 (planned), TDK-08, TDK-09, M94A-A14 |
| DS-27 | **Confirm (planned):** VS07 already asks to "inspect inner corners against padding" and M94.2 checkbox 4 inspects "nested corners" (M94.2–M94.3). Add only: write the rule (`inner = outer − padding`) into the sheet and check it in the DS-19 specimen. Mapping the 28 literal radii waits for owner acceptance ("No radius or color-token migration is part of this slice", `composition-sheet.md`) | M94.2 (VS07) | P2 | S | AFFiNE `radio/styles.css.ts:13`, TD radius comment [read]; Menu and Segmented already comply (`rounded-lg p-1` → `rounded-sm`) [read] | VS07 (planned), AFN3-06, TDK-07 |
| DS-28 | **Merged into DS-01:** fix the 5 drifted Mermaid fallbacks under DS-01's fallback-equality check. No JS token map: canvas/SVG consumers already resolve live tokens (`src/mermaid/theme.ts:12-16`, `src/views/chartExport.ts:127`, CSS vars in `src/whiteboard/SceneSvg.tsx:24`), and the fallbacks serve only stylesheet-less vitest (`theme.ts:6-8`) | M94.2 (with DS-01) | P2 | S | `src/mermaid/theme.ts:17-34` [read]; AFFiNE `use-theme-value.ts` [docs] | AFN3-15 |
| DS-29 | Draw `/`, `@`, `[` menus in the DS menu look (the `MenuSurface` and `MenuItem` styles) through BlockNote's `suggestionMenuComponent`, keeping its combobox keys and the CV-24-filtered `/` item builder unchanged (only the drawing moves). Take the styles, not the components: `MenuSurface` moves DOM focus (`autoFocus` defaults true, `src/components/ui/Menu.tsx:32,48-50`) and `MenuItem` draws `role=menuitem` buttons, which would pull focus out of the editor; the list keeps focus in ProseMirror and renders the controller's `bn-suggestion-menu`/`-item-<i>` ids as listbox/options (M94A-A17) | M94.3 | P2 | M | Morrow `M/src/app/editor/SuggestionMenu.tsx` (own Tiptap suggestion list, not BlockNote) [read]; BlockNote `SuggestionMenuController.d.ts:12` `suggestionMenuComponent` [read] | MOR-07, M94A-A17 |

> **2026-10-27 (Codex cross-check, CX-AFE-11):** Gate met: the owner accepted the refined composition on 2026-10-25; the editor stays a quiet exception, so this is a menu restyle only, schedulable in M94.3.

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| DS-30 | Promote the MIT `components/ai/Item.tsx` (and `Badge`) to `components/ui` as the one row/card anatomy for Pages, Home and settings rows. The notice stays in THIRD_PARTY_NOTICES.md; `components/ai` then imports it, so CV-64's AST walk covers it and it must stay store-free | M94.6 | P2 | S | Macro `Item` [read listing]; Activepieces `item.tsx` [names]; 11 `.cb-*-row` families [docs] | MAC-10, M94A-C03 |

> **2026-10-27 (Codex cross-check, CX-MAC-11):** `Item` now has 4 importers, all in the agent/AI layer (`src/agent/NativeRecoveryHistory.tsx`, `src/agent/RecoverySummary.tsx`, `src/agent/rail/ConnectorsCard.tsx`, `src/components/ai/Confirmation.tsx`); no `components/ui` copy. Promote before M95 recovery work adds more.

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| DS-31 | Delete or adopt `Tag` and `StatusFlag` (0 importers); if adopted, `StatusFlag` becomes the row marker for unresolved or failed saves (text + icon, not colour alone), drawing M93's retained-save state (REL owns it; M93.2, `unresolvedOpenPages()` in `src/editor/openPages.ts`), never its own | M94.5 | P2 | S | importer counts [read]; Tolaria row save dots [docs] | TOL-12 |

### Owner decisions

1. Approve `M94.new-ds-roles` (state layers, overlay surface, ink/line utilities) for new and changed surfaces under ratchets. It goes past the composition sheet's "no radius or color-token migration".
2. Hover/press as translucent ink (6 repos) or opaque steps (Activepieces' rule)? Selection stays an opaque role either way.
3. Dark `--surface-selected`: keep the hue-only cue (1.02:1) or step it up to at least hover's delta?
4. Controls under 3:1 (Switch track, 1.62:1 input/secondary borders): fix now or declare exceptions in the pair table?
5. Checkbox: global skin (Morrow-style, Apache) or a `Checkbox` primitive plus a CV-63-style rail?
6. Contrast mode: automatic under macOS Increase Contrast, an explicit theme, both, or neither?
7. Danger toasts: assertive and kept until dismissed? (No notification center either way.)
8. Specimen captures as a separate "component evidence" class, never journey or aesthetic acceptance?

## Verification - reference fidelity (2026-10-24)

Checked 130 of 159 rows; confirmed 111, corrected 19, removed 0.

- Scope: all 31 Recommendations, all P0/P1 rows (G1–G13, inventory #5 and #42), all Keep, Cut, Conventions and Styling rows, every matrix row, 20 of 48 inventory rows, G14 and G16–G18. Counts table is Cerebro-only and was spot-checked, not scored.
- Held up on re-read: AP var/class checker and its `@tailwindcss/node` import of `__unstable__loadDesignSystem` (also exported by `tailwindcss` 4.3.3 `dist/lib.js`), the 432-seed AP contrast sweep, Outline `depths.ts` and `MenuProvider`, Macro z bands, `--color-hover` 3%/6%, gallery render test and `ui-audit.ts`, the AppFlowy 5%/10% and 15%/20% fills, 400/560/720 modal sizes and 4 vs 136 popovers, Morrow `.05/.085` and its checkbox skin, n8n 720px settings and non-gating Chromatic, Plane contrast themes, `TContextMenuItem.description` and busy-vetoed confirm, and no `prefers-contrast` in any reference.

| Row ID | Verdict | What was wrong / what the code shows (path [read]) |
| --- | --- | --- |
| Matrix · Surfaces (AppFlowy) | corrected | Dark layer-01..04 are Neutral 900/850/850/830, so not one step per layer (`AFUI/script/Semantic.Dark Mode.tokens.json`) [read] |
| Matrix · Lines (AFFiNE) | corrected | `insideBorder` values sit in the unvendored npm theme. Only the Android mirror's divider is visibly translucent, alpha 0.22 (`AF/packages/frontend/apps/android/App/app/src/main/java/app/affine/pro/theme/Colors.kt:335`) [read] |
| Matrix · State layers (AFFiNE, Plane) | corrected | AFFiNE's `hoverOverlay` value is unvendored; translucency is inferred because the `::before` paints over the label (`AFC/ui/button/button.css.ts:44-62`) [read]. Plane "opaque" had no basis: propel values are unvendored, and only the `bg-layer-N hover:bg-layer-N-hover` rule is visible (`PL/packages/tailwind-config/AGENTS.md:241-261`) [read] |
| Matrix · Elevation (AFFiNE) | corrected | `menu/styles.css.ts:15-16` holds `overlayPanel` + `menuShadow`; `popoverShadow` is at `AFC/ui/modal/styles.css.ts:179` [read] |
| Matrix · Depth (n8n, Tolaria) | corrected | `APP_Z_INDEXES` has 23 keys, not 24 (`N8N/packages/frontend/@n8n/frontend-constants/src/z-indexes.ts:9-33`) [read]. Tolaria also writes 2³¹−1 (`T/src/main.tsx:210`) [read] |
| Matrix · Motion (AFFiNE, Plane) | corrected | AFFiNE honours reduced motion in 2 sheets: `AFC/ui/modal/styles.css.ts:98` and `AF/packages/frontend/core/src/blocksuite/ai/components/ai-message-content/stream-objects.ts:251` [read]. Plane has 148 `transition-all` in apps + packages; the ×35 matched only `transition-all duration-300` pairs, which grep finds 39 times [read grep] |
| Matrix · Contrast (Cerebro) | corrected | The 25 pairs include 3 raw-step semantic pairs, `--{warn,danger,success}-700` on `-50` (`src/styles/contrast.test.ts:33`) [read] |
| Cut · `content-visibility` rows | corrected | REL-08 measured nothing; it bars the return. The AX loss was measured in M84–M90 (`plans/2026-10-17-m84-m90-implementation-record.md:95-98`) [read] |
| Cut · Blanket reduced motion | corrected | Plane ×148, not ×35 (see Motion) [read grep] |
| Inventory #21 Checkbox (AFFiNE) | corrected | The input is not inside its label: a `role=checkbox` div wraps an icon, the native input and a sibling `<label htmlFor>` (`AFC/ui/checkbox/checkbox.tsx:66-90`) [read] |
| Conventions · Reduced motion | corrected | AFFiNE 2 sheets, not 1 (see Motion) [read] |
| Keep 1 | corrected | Macro resets the palette too (`MAC/src/index.css:376`), and raw palette classes fail CI (`macro-main/rules/ast-grep/tsx-no-raw-tailwind-palette.yml`, `severity: error`) [read]. Cerebro stays ahead on breadth (radius, text, leading) |
| Keep 3 | corrected | Plane ×148 [read grep] |
| DS-02 | corrected | The evidence said "role pairs only"; the test also checks 3 semantic 700-on-50 pairs (`src/styles/contrast.test.ts:33`) [read] |
| DS-04 | corrected | Macro also has render boundaries (Solid `ErrorBoundary`, 23 files, e.g. `MAC/src/index.tsx:86`) [read grep], so 7 repos converge, not 6 |
| DS-07 | corrected | AFFiNE's translucency is inferred and its value unvendored (see State layers) [read] |
| DS-26 | corrected | TD's dark weight trim is `TD/src/app.css:181-186` (floor 400); `77-86` is the light scale [read] |
| DS-29 | corrected | Morrow's `SuggestionMenu.tsx` is a `@tiptap/suggestion` list, not BlockNote, so it is an idea precedent only [read]. BlockNote's `suggestionMenuComponent` is confirmed (`node_modules/@blocknote/react/types/src/components/SuggestionMenu/SuggestionMenuController.d.ts:12`) [read] |
| G18 | corrected | Line 33 repeats the drifted `--n-25` fallback: 5 values at 6 sites (`src/mermaid/theme.ts:17,27-29,33-34`) [read] |

## Verification - Cerebro fit (2026-10-24)

Checked 58 rows; confirmed 34, corrected 24, reclassified 0, removed 0.

- Supersedes this file's earlier fit pass (55 rows: 32 confirmed, 20 corrected, 3 reclassified, G19 added). Its edits stay in the rows above and still hold on a fresh read. This pass re-read every Recommendation and Gap row later on 2026-10-24, with 495 `src/` and `src-tauri/` paths dirty from concurrent agents.
- Scope: DS-01–DS-31, G1–G19, Bottom line P0s, Counts, Matrix · Ink, Cut · scrollbars, Evolve step 2, inventory #24, Keep 1–15, Owner decisions. Read: M94 plan and spec, `composition-sheet.md`, the M94 evidence README, the VS dossier, the implementation record's Current disposition, M93 phase list, sibling `audit-m93`, `audit-m94a`, `audit-m94b`. Every [calc] value reproduces under a read-only script.
- Implemented already: none of DS-01–DS-31. No `--z-*`, `--state-*`, overlay or `--elev-*` token, `text-ink-*`, `data-contrast`, Skeleton, `pending`, Dialog `size`, toast tone or key, `isImeEnter`, var-definer test, `ds-adoption` test or `ui-roles` skill; `role="tree"` only in `RootTree`. Partly in the tree: `--surface-raised` (DS-08), `ConnectorInventory` (DS-17).
- The five P0s still hold: ContextMenu unchanged (`src/components/ui/ContextMenu.tsx:6-11,83,96`); M94.4 guards `isComposing` only; the 3 undefined vars; no dark synapse-600/700; 0 boundaries.
- Rule fit: no row breaks CV-03/04/05/07/21/25/33/37/41/47/62/63/64, files-first or the no-API-key path. Plan constraints applied: M94.2's "no repository-wide CSS replacement" (DS-06), the Global Constraints on class-name tests (DS-01, DS-20), "amend its file map before coding" (DS-05, DS-22, DS-25).
- Sibling conflicts for the synthesis: DS-05 (M94.5) vs M94A-N01 (3) (ds-roles); DS-12/DS-13 (new-primitive-gaps) vs M94B-A12/A24 (M94.8); DS-16 builds in M94.8, M94A-A05 in M94.2, whose file map has no primitive.

| Row ID | Verdict | Reason (Cerebro path or plan section) |
| --- | --- | --- |
| Bottom line · P0s | corrected | All five hold; the IME P0 also covers `src/app/CreateLauncher.tsx:101` |
| Counts | corrected | Row 14: the one `transition: all` is a comment (`src/styles/motion.css:13`); 10 literal `ms` outside tokens, not 15. Drift note added for rows 1, 4, 5, 8, 10, 12 |
| Matrix · Ink | corrected | `text-inverse` is a mapped text role (`src/styles/index.css:100`), so not "no utility" |
| Cut · Hidden scrollbars | corrected | Cerebro hides two locally (rail, `src/app/shell.css:17`; ViewTabs strip, `src/views/ViewTabs.tsx:233-235`); the cut is the global hide |
| Evolve step 2 | corrected | Follows the DS-05 and DS-06 corrections |
| Inventory #24 | corrected | 32 guard lines in 22 files, 8 (7 files) test 229; three M94.4 entries |
| Keep 1–15 | confirmed | Spot-read `index.css:17-30`, `theme.test.ts`, `contrast.test.ts:28-49`, `spacing.css:46-130`, `layers.ts` (`modal` defaults true), `ToastHost.tsx:76-81`, 61 primitive tests, `table-chrome.css` visibility (its concurrent edit leaves that intact) |
| G1 | confirmed | `ContextMenu.tsx` unchanged: no `disabled`, z-50, literal shadow, React `stopPropagation`; 0 of 10 consumers call `useLayer`; `src/lib/keys/root.ts:112-144` stands down only for editable or modal targets |
| G2 | confirmed | Re-scan finds only `--info-50/700`, `--danger` and the dead hook (other hits are comments); the `--danger` literal is 2.03:1 on dark `n-50` [calc] |
| G3 | confirmed | 2.22/1.70, 3.49, 4.35/3.99 reproduce [calc]; 4 synapse sites; `select.css:103-105`; `CreationDraftRecovery.tsx:22` is `text-xs text-n-500` |
| G4 | confirmed | 0 boundary hooks; `src/main.tsx:15` |
| G5 | confirmed | 274 in 132 files; 7 washes; ghost `n-50` (`Button.tsx:24`) vs IconButton `n-100` (`IconButton.tsx:12`) |
| G6 | corrected | The dark raised surface exists (`colors.css:164,336`); the gap is that the overlays skip it |
| G7 | confirmed | 17 values; 1100 ×3; order only in comments (`Popover.tsx:435-443`, `Dialog.tsx:9`, `ToastHost.tsx:68`) |
| G8 | confirmed | Holds; counts drift (3,277 vs 225; 156 `text-(--text-meta)`) |
| G9 | confirmed | `Switch.tsx` track `n-300`/`--accent`; `select.css:166-168` |
| G10 | confirmed | No pending, Skeleton, Checkbox, Textarea or Tabs primitive; 55 hand-rolled unavailable markers now |
| G11 | confirmed | `Menu.tsx:52-83`: arrows, Home, End only |
| G12 | confirmed | `src/lab/main.tsx:6-10` |
| G13 | confirmed | `role="tree"` only at `RootTree.tsx:196,214` |
| G14 | confirmed | 1.02 vs 1.15 [calc]; input to VS10 |
| G15 | confirmed | `IconButton.tsx:67`; 12 `text-[Npx]`, 30 sizes, 28 radii |
| G16 | confirmed | 0 `prefers-contrast` in `src` |
| G17 | confirmed | `MarkdownEditor.tsx:1750,1771,1812` |
| G18 | confirmed | `src/mermaid/theme.ts:17-34`; fallbacks serve vitest only |
| G19 | corrected | Adds `CreateLauncher.tsx:101` (`isComposing` only; starts a flow, writes nothing); counts 32 and 8 |
| DS-01 | corrected | Labelled a lint rail, never styling proof (M94 Global Constraints); P0 also rests on concurrent CSS work and the 2.03:1 dark `--danger` [calc]. No definer test exists (`theme.test.ts` checks classes) |
| DS-02 | corrected | Blast radius: 4 dark-only ink sites, no fills, light unchanged; link ink is untested too (`contrast.test.ts:34-43`); reconciled with M94A-A02 |
| DS-03 | corrected | `MenuItem` skips disabled rows on purpose (`Menu.tsx:23-26`), so the reason must be row text. P0 kept: M94.5's file map must change before coding |
| DS-04 | confirmed | Confirm row; `StateMessage.tsx:16-43`; M93-N01 owns placement |
| DS-05 | corrected | Phase M94.2 → M94.5 with DS-03: M94.2 edits tokens only "where the accepted role requires it" (plan M94.2, Files), and M94.5 tests the layers (checkbox 4). No owner gate needed |
| DS-06 | corrected | A `--shadow-*` rename is 68 refs in 59 files, which M94.2 rules out (checkbox 5). The reset alone fixes the defect: Tailwind inlines its own theme value (`tailwindcss` 4.3.3 `dist/lib.js`), and the DS `:root` names survive it |
| DS-07 | confirmed | Owner-gated; no `--state-*`; 7 in-tree `color-mix` washes |
| DS-08 | corrected | `--surface-raised` is already the dark step up, AA-tested (`contrast.test.ts:39`), with 24 uses; overlays need DS-07 first, or their `n-50` rows darken in dark |
| DS-09 | confirmed | Owner-gated; maps through `--color-*`, clear of the `--text-*` size namespace (`index.css:136-137`) |
| DS-10 | corrected | `motion.test.ts:159-173` reads three injected sheets: retarget it, or the motion rail loses them |
| DS-11 | corrected | Fixes wait on Owner decision 4 and a both-theme capture; tests behavioural |
| DS-12 | confirmed | No `pending` (`Button.tsx:37-60`); `DialogAction` lacks it (`Dialog.tsx:36-41`); the two 960px lightboxes confirmed |
| DS-13 | confirmed | No Skeleton; `LAB_STATES` has five (`presets.ts:22`); CV-44 untouched |
| DS-14 | confirmed | `ToastItem` has no tone (`uiStore.ts:602-606`); `Toast` draws 5; unplanned in M93–M99 |
| DS-15 | corrected | (b) adds `CreateLauncher`; (a) a new rail is a new CV id; current work adds raw checkboxes |
| DS-16 | confirmed | `SettingsPage.tsx:50-73` has no `aria-describedby`; the M94.8 build fits (M94.2's file map has no primitive) |
| DS-17 | corrected | `ConnectorInventory` is implemented (`AgentProperties.tsx:51-54`): a union to fold in, not the planned first consumer |
| DS-18 | corrected | Keycaps are M94B-A01's proposal, not M94.5's text |
| DS-19 | confirmed | The lab has state and composition branches only; dev-only entry |
| DS-20 | corrected | One baseline definition for the merged ratchet (55 in 41, vs M94B-A18's 92 in 74 with the lab) |
| DS-21 | corrected | Skill body at most 80 lines (`scripts/dev-skills.test.ts`) |
| DS-22 | corrected | Phase M94.3 → M94.5: the keys are command rows (CV-47) in M94.5's registry audit; M94.3 is the in-flight capture slice; matches M94A-A09 |
| DS-23 | confirmed | One hook decider (`colors.css:222-226`); owner-gated P2 |
| DS-24 | confirmed | Confirm row (VS10; M94.2 checkbox 4) |
| DS-25 | corrected | Same files as DS-10; M94.2's file map lists no primitive; `Tag` depends on DS-31 |
| DS-26 | confirmed | `theme.test.ts:78-93` skips arbitrary sizes; VS04 planned |
| DS-27 | confirmed | Confirm row |
| DS-28 | confirmed | Merged into DS-01; consumers read live tokens |
| DS-29 | corrected | `MenuSurface` would take focus from the editor (`Menu.tsx:32,48-50`); draw the look only, with BlockNote's ids as listbox/options |
| DS-30 | confirmed | `Item`: 1 app and 1 AI importer; CV-64 walk; MIT notice |

> **2026-10-27 (Codex cross-check, CX-MAC-11):** Now 4 importers (3 app, 1 AI).

| Row ID | Verdict | Reason (Cerebro path or plan section) |
| --- | --- | --- |
| DS-31 | confirmed | `Tag` and `StatusFlag` have 0 importers; `unresolvedOpenPages()` at `openPages.ts:205`; deleting `Tag` also trims DS-10 |
| Owner decisions 1–8 | confirmed | No rule conflicts; decision 4 now gates DS-11 |
