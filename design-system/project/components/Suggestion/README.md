# Suggestion

A conversation starter sent in one press: a borderless row with its label and an arrow.

- Use it in an empty conversation's welcome, under `Suggestions` named with `aria-label` ("Conversation starters").
- Props: `suggestion` (the prompt `onClick` hears, and the label unless children replace it), `children` (the shorter label a row shows when the prompt is structured), `description` (a quieter line, read as the row's description), `onClick(suggestion)`, `icon` (trailing Lucide name, default `arrow-up-right`; `null` for none), `disabled`.
- Starters come from `composerStarters`: the same three where nothing is open ("What is at risk right now?", "Help me clear the Inbox", "What do you know about this vault?"); on a page, the acts its own surfaces offer ("What does Knowledge say about this?", "What's missing?", "Learn from this page"), each sending its structured prompt.
- Rows, not shadcn's outlined pills (a deliberate deviation; the e2e pins border 0): 9px x `sp-3` padding, `r-md`, `fs-sm` in `text-secondary`, `surface-sunken` on hover, `sp-1` apart.
- The description is `text-muted` at `fs-xs`; the 14px arrow is `text-muted` and leans 2px the way it points under the pointer.
- Focus is a 2px `border-focus` outline; disabled is 50%.
- Presentation only (CV-64): pressing it calls the caller, which sends.
