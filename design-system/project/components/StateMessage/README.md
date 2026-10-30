# StateMessage

The words for a section that is loading, empty, not recorded, partial or unavailable.

- Presentation only: the read that owns the section decides the state and supplies the copy.
- Props: `state` (`loading`, `empty`, `not-recorded`, `partial`, `unavailable`), `title`, `children` (the description), `action` (a node, usually a small `Button` such as "Try again"), `compact` (default `false`), `testId`.
- Icons, 16px: `clock` (loading), `inbox` (empty), `info` (not recorded, partial), `circle-alert` (unavailable).
- Default: a `surface-sunken` well with a `border-subtle` border, `r-md`, `sp-4` padding, `sp-3` gap, `text-ui` in `text-secondary`; the title in `w-medium` `text-primary`, the description `sp-1` below it, the action `sp-3` below that.
- `compact` drops the well (`sp-3` vertical padding, no border, no fill), for rail cards, panels and lists.
- `unavailable` takes a `danger-200` border and a `danger-700` icon, and carries `data-testid="section-unavailable"` unless `testId` says otherwise. `loading` carries `role="status"`.
- Unavailable is never empty: "we could not tell you" and "nothing is there" are opposite sentences, and a failed read never passes through an empty branch (CV-05).
- `not-recorded` uses words, never `0`; `partial` says what it skipped ("Some of these runs couldn't be read").
- Loading titles say what is being read ("Reading agent activity…") with no animated-only indicator.
- Every section that reads ships all five states as state-lab presets (CV-44).
