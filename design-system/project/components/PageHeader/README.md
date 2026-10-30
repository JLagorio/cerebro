# PageHeader

The shared head of a surface: its title, a quiet fact beside it, its actions at the far end, and a line on what the page is for.

- Use it at the top of a surface or a database: Studio, History, Library, Agents, Pages, My work, Knowledge, Settings, a database's table, a file's viewer. A document page has none; its title is the first heading of its body.
- Props: `title` (ReactNode; a button when the name is editable), `icon` (ReactNode), `metadata` (a count or a word: "12 open", "Settings"), `description`, `actions`, `headingTestId`, `className`, `variant` (`'workspace'` default, `'compact'`, `'tool'`) and `composition` (`'collection'` or `'utility'`).
- `workspace`: `sp-8` `sp-6` `sp-5` padding; the heading in the `workspace-title` role (24/32), semibold `n-900`, tracked -0.025em; the icon in a 32px `r-lg` well on `surface-sunken` in `text-secondary`.
- `compact` and `tool` sit on an `n-100` hairline with the heading in the `section-title` role (16/24): compact, `sp-3` vertical padding, for an item opened under its surface (an open Studio prototype, its icon the way back), tool with `sp-2` vertical padding and a 28px bare icon for a file's viewer.
- One line holds icon, heading, metadata and actions, `sp-3` apart, wrapping when narrow (`sp-2` under 520px). Metadata is `text-meta` at `fs-meta`; actions push to the end, `sp-2` apart, usually one primary `Button` or an `IconButton`.
- The description sits `sp-3` below at `fs-ui`/`lh-ui` in `text-secondary`, at most 76ch: one sentence on what the page holds ("Your open work, organized by when it needs you.").
- `composition` is opt-in and needs a `.cb-composition` ancestor, which owns the width: its inset steps 16, 24, 32px at 600 and 960px container widths. It drops the variant's hairline; `collection` pads `sp-10` above and `sp-6` below with a 28/36 heading, `utility` pads `sp-8` and `sp-5` and keeps the `workspace-title` role.
- Never put a count in it that the page cannot show, or `0` for a number nobody recorded: say "Unavailable" or "not recorded" (CV-05).
