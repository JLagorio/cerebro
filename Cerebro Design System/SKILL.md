---
name: cerebro-design
description: Use this skill to generate well-branded interfaces and assets for Cerebro, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

Cerebro is an internal product system (objectives/KRs → initiatives → products/components/features/subfeatures → releases, plus a knowledge base + AI layer named "Cerebro"). Key entry points:

- `readme.md` — brand context, CONTENT FUNDAMENTALS (voice), VISUAL FOUNDATIONS (color/type/spacing/motion rules), ICONOGRAPHY (Lucide via CDN; entity glyph map), and the file index.
- `styles.css` → `tokens/*.css` — all CSS custom properties (`--cortex-*` primary, `--synapse-*` AI-only violet, `--n-*` neutrals, `--ent-*` entity colors, spacing/radius/shadow/layout constants) and `@font-face` (Instrument Sans, IBM Plex Mono in `assets/fonts/`).
- `components/` — React primitives (Button, Input, Select, Checkbox, Radio, Switch, SegmentedControl, Icon, Badge, Tag, Avatar, Card, EntityIcon, HealthChip, ProgressBar, StatusFlag, Tabs, FilterChip, Dialog, Tooltip, Toast, EmptyState, AskBar, AISummary, KanbanCard). Each has `<Name>.prompt.md` usage notes.
- `ui_kits/cerebro/` — the full app recreation (shell, OKR grid, roadmap timeline, delivery kanban, knowledge view, agent home); copy its patterns for any new screen.

Hard rules: synapse violet only on AI surfaces; no gradients; no emoji; sentence case; Lucide icons only; flat scrims; 4px grid.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.
