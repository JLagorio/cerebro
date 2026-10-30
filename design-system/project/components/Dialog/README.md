# Dialog

The modal for a decision or a short form that needs the person's full attention.

- Use it to create, rename, convert or confirm a destructive act. For anything anchored to a control, use `Popover`.
- Props: `open`, `title`, `onClose`, `children`, `width` (max px, default 560), `primaryAction` and `secondaryAction` (`{ label, onClick, disabled, testId }`), `footerNote`, `style`, `fullscreen`.
- Scrim: `scrim` over the whole window, `z-index` 1000, the panel held in the upper part, `clamp(16px, 8vh, 64px)` from the top with 24px sides.
- Panel: `n-0`, `r-xl`, `shadow-lg`, never taller than the window less both edges.
- Header: `text-lg` 600 title in `n-900` with `track-tight`, padded 18px 20px 0 24px, and a Close `IconButton`. Body: 16px x 24px padding, `text-ui` in `n-800`, scrolls when tall, inside a compact `SectionBoundary` ("This dialog").
- Footer (only with an action or a note): an `n-100` hairline, 14px x 24px padding, the note left (`text-xs`, `text-muted`), then the secondary `Button` and the primary `Button`, right-aligned with 8px between.
- Name it for its act ("New database", "Delete "Duplicate jobs after reconnect"?") and repeat the verb on the primary ("Create", "Delete"). Disable the primary until the form can be submitted.
- Focus moves to its first control unless a child took it (`autoFocus` on the field), Tab stays inside while it is on top, and focus returns to the opener on close.
- Escape closes it only when it owns the key in `layers.ts` (CV-47), on the bubble phase, so a menu or field inside answers first. A press on the scrim closes it, unless that press only closed a list open over it.
- Motion: the scrim fades in on `--motion-pop`; the panel rises 6px from scale .98 on `--motion-enter` and leaves as a fading copy on `--motion-exit`.
- `fullscreen` fills the window with no scrim padding, radius 0 and an unpadded flex body, for a surface that is a page (the layout editor).
