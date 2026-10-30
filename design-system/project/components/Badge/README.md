# Badge

A short label beside a title in an AI surface: a model, a count, a subagent type, a connector, a file.

- Use it after a step's or card's title: `secondary` for a subagent type ("cerebro-researcher") or a test count ("Passed: 42"), `outline` for a model ("claude-opus-5-5"), a connector a call ran on ("Gmail") or a file chip, `destructive` for a failure count ("Failed files: 2").
- Props: `variant` (`default`, `secondary`, `destructive`, `outline`, `ghost`, `link`; default `default`), `children`, and `render`, an element (a link, a button) to draw as instead of a `span`, which keeps its own props and gains the badge's classes.
- Pill: 20px tall, `sp-2` sides, `r-full`, `fs-xs` 500, one line, never wraps; a leading icon draws at 12px.
- Inks: `default` is `action-primary` with `on-action-primary`; `secondary` an `n-100` fill with `n-800` (inside a rail card it steps up to `n-200`, so it reads in dark); `destructive` `danger-50` with `danger-700`; `outline` a `border-subtle` hairline with `n-800`; `ghost` `n-700`, `n-100` on hover; `link` `text-link`, underlined on hover.
- Focus is `border-focus` plus `ring`; `aria-invalid` turns the border `danger-500`.
- Put the words a screen reader needs inside it, visually hidden ("by the", "on", "Model:"), and say a connector's reach in `title` ("Ran on the Gmail connector, outside this vault").
- For a monospace path add `cb-ai-mono` (as `TaskItemFile` does).
- Presentation only (CV-64): it draws its props and reads no store, IPC or agent model.
- Don't: use it for workflow status (that is `StatusFlag`), or colour alone to carry a state; the words say it.
