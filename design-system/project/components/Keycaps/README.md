# Keycaps

Keyboard hints read from the command catalog, so a hint can never disagree with the binding it names.

- Use it wherever a shortcut is taught: tooltips, menus, Quick Open's footer, Settings → Keyboard shortcuts.
- Pass `command`, an id from the app's command catalog (`palette.open`, `go.pages`); the caps draw every key that row binds. An unknown id throws rather than show a stale hint.
- A key local to one dialog or composer passes `keys` instead: one spec (`"mod+enter"`) or a list of alternatives. Specs use `mod`, `alt`, `shift`, named keys (`enter`, `arrowdown`) and a space for a chord (`"g p"`).
- `mac` picks the platform labels (detected by default): macOS draws glyphs (⌘ ⌥ ⇧ ↵) as separate caps; elsewhere caps are named (Ctrl, Alt, Shift, Enter) and the spoken text joins them with "+".
- Steps of a chord join with "then", alternatives with "or" (in `fs-xs` 12px, 2px padding), and adjacent ascending digits with the same modifiers collapse to a range (⌘1–9).
- Caps take the base `kbd` style: `font-mono` at `fs-2xs` 11px on a 16px line, `text-muted` ink, `n-50` ground, `n-200` border with a 2px bottom edge, `r-xs`, 5px side padding, 16px minimum width, centred. Caps in one step sit 2px apart; groups 4px.
- The wrapper carries an `aria-label` that reads the whole hint ("G then P", "Ctrl+Shift+N") and `data-keys` with the raw specs. `className` passes through (Tooltip passes `text-n-200` on its dark bubble).
- `keycapText(command, mac)` and `keysText(keys, mac)` return the same hint as plain text, for a title or a sentence.
- Don't: type a shortcut into copy by hand; bind it in the catalog (CV-47) and show it through this.
