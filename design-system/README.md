# design-system

The source of Cerebro's published design system (M100). Values come from the
app; this folder holds the words.

- `project/` — what the artifact shows, mirrored at its published paths:
  `README.md` (the brand book), `components/<Card>/preview.html` and
  `README.md` (one card each), `components/Cover/preview.html`, and
  `assets/Icons/README.md`.
- `system.json` — the artifact's url, the card order and the modules the bundle
  carries beyond `src/components/ui/` and `src/components/ai/`.
- `tokens.notes.json` — a usage note for every token and the type styles; the
  values themselves are read from `src/styles/tokens/`.
- `icons.json` — the icons already uploaded to the artifact: blob id, size and
  sha256 per name.

`pnpm ds:build` writes `out/` (ignored); the `design-system-sync` dev skill
(`.claude/skills/design-system-sync/SKILL.md`) publishes it.
