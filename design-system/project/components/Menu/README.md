# Menu

The chrome and keyboard every menu shares; placement and dismissal belong to `Popover`.

- Use it inside `Popover role="menu"` for action menus, drill-in property menus and pickers. Never place or dismiss a menu yourself.
- `MenuSurface`: `children`, `width` (px, optional), `className`, `autoFocus` (default `true`: first item takes focus on open; pass `false` for a drill-in that should leave focus alone). Panel is `n-0` on an `n-200` border, `r-lg`, `shadow-lg`, 4px padding.
- `MenuItem`: `label`, `onSelect`, optional `icon` (13px Lucide, `n-500`), `hint` (right-aligned current value, `text-2xs` `n-400`), `submenu` (11px `n-400` chevron), `checked` (12px `cortex-600` check), `danger`, `disabled`, `title`, `testId`, `onMouseDown` (runs before focus moves, for actions on a text selection).
- Items are 32px minimum, 5px x 8px padding, `r-sm`, `text-ui` in `n-700`, with an `n-50` wash on hover and focus-visible on `--motion-hover` (20ms: menus are read by sweeping).
- `danger` items use `danger-600` with a `danger-50` wash and sit last, under a separator. Disabled items stay in the DOM in `n-400` and take no arrow-key stop.
- `MenuLabel`: an uppercase `text-2xs` medium group heading in `n-400`; not a stop.
- `MenuSeparator`: a 1px `n-100` rule with 4px margins.
- `MenuBack`: the 24px back arrow (`n-500`, labelled "Back to <title>") and a `text-sm` semibold `n-900` title a menu grows when it drills in.
- Arrow keys, Home and End move focus; a control inside that already took the key (an open `Select`) keeps it, and a text input keeps Home and End. Escape is the Popover's, through `layers.ts` (CV-47).
- Labels are sentence case; an item that opens a further step ends with an ellipsis ("Upload a file…"). Show a value beside its row with `hint` rather than hiding it a level down.
