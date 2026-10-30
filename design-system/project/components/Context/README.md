# Context

How much of the model's context window the conversation uses: a ring and its figure in the composer's toolbar, the detail in a hover card, and what the window holds row by row.

- `Context` props: `usage` (`ContextUsage`), `tabIndex` (pass 0: WebKit leaves a bare button out of the Tab order), `testId`, `className`. Hovering it or focusing it from the keyboard opens the detail.
- `ContextUsage`: `{ state: 'recorded', used, window?, model?, breakdown? }` (breakdown: `input`, `cacheRead`, `cacheWrite`, `output`), `{ state: 'not_recorded' }` or `{ state: 'unavailable' }`. `useContextUse` pulls it; the element reads nothing.
- Its name is the reading ("62% of context used", "Context use not recorded", "Context use unavailable"), never a "Context:" prefix; the ring is decoration.
- Absent is never zero (CV-05): not recorded is a dashed ring with no figure; unavailable says so and carries `section-unavailable`; a count that is no number reads not recorded; a sliver reads "<1%", never "0%"; with no window the figure is the count ("41.2K").
- Levels: from 80% the ring is `warn-600` and the card's fill `warn-500`; from 95% `danger-600` and `danger-500`.
- Detail card: "124,000 of 200,000 tokens", a 4px meter (`n-100` track, `n-500` fill), "62% used", then Model (mono) and the counts, `text-meta` terms with tabular figures.
- `ContextCategories` props: `categories` (`key`, `name`, `kind`, `tokens` or null), `window` (null draws no bar), `more` (rows not shown). Kinds: `used` takes a hue in a fixed order (`opt-blue`, `opt-orange`, `opt-pink`, `opt-yellow`, `swatch-teal`, `opt-purple`, `opt-green`, then `opt-gray`); `free` is the `n-200` track; `buffer` is hatched `n-400` on `n-200`; `deferred` is an outlined swatch reading "not loaded".
- Bar: 8px, `r-full`, `sp-05` gaps; legend `fs-meta` in `text-secondary`, values in `text-primary`, tabular. The legend carries every number in words.
- Trigger: 32px, `r-md`, `fs-xs` tabular in `n-500`; `n-50` with `n-800` on hover; focus `ring`.
