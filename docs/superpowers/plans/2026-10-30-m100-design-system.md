# M100 — Design system

**Milestone:** M100 · **Phases:** M100.1–M100.4 · **Status:** implemented, awaiting owner review.

Cerebro's design system is published as a claude.ai Design System artifact (the
url is in `design-system/system.json`). It is generated from the app: tokens
from `src/styles/tokens/`, a live React bundle of `src/components/ui/` and
`src/components/ai/`, tsc's types and the Lucide icons the app names. The words
(brand book, card previews and guides, token notes) live in `design-system/`.

## Phases

- **M100.1 — Sync producer.** `pnpm ds:build` (`scripts/design-system/build.ts`)
  rebuilds every artifact file into `design-system/out/` and lists what to
  upload and publish; `pnpm ds:build index` merges the artifact's freshly read
  index. Publishing is the `design-system-sync` dev skill. The build fails on
  token or card drift and warns on a component module with no card.
- **M100.2 — Text contrast.** Every hue's 600 step holds AA on the six neutral
  surfaces in both themes, and the cortex and synapse 700 ink on their 50
  ground (`src/styles/contrast.test.ts`). Light warn-600 and success-600 darken;
  dark cortex-600 lightens; synapse gains dark 600 and 700 ink steps.
- **M100.3 — ContextMenu on the layer stack.** Escape goes through
  `useEscapeLayer` (CV-47); items gain focus-visible washes; the panel uses the
  `shadow-lg` token.
- **M100.4 — App shell cards.** AppShell, AppRail, Sidebar and PageToolbar are
  compositions of the app's real markup and classes (those components read
  app state); PageHeader and ListSelectionBar mount live.

## Decisions

- The bundle carries React 19 as two classic-script libraries; the artifact
  type's default React 18 would break ref-as-prop components.
- Shiki ships a curated grammar subset (`scripts/design-system/shiki-subset.ts`)
  to keep the bundle under the artifact's 6 MB cap; other languages render
  plain, the highlighter's own fallback.
- Motion stays in `components/bundle.css`: the artifact's token format has no
  motion family.
- Amber reaches 4.5:1 on near-white only near its 700 step, so light warn-600
  and warn-700 now sit close together.

## Verification

Every card renders in light and dark in Chromium against the built output with
no console errors or warnings, and each card's marker height matches its
content. Unit: `scripts/design-system/tokens.test.ts`,
`src/styles/contrast.test.ts` (fails on the previous colours),
`src/components/ui/ContextMenu.test.tsx` (the two Escape tests fail on the
previous component).
