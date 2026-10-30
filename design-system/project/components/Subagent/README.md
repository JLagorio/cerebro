# Subagent

A subagent the run started: what it was asked, what kind it is, its tool uses and time, and opened, its steps and what it found.

- Use it for Claude Code's Agent call; use `SubagentHandoff` for a Cerebro `hand_to`, which starts a separate run and never says the work is done.
- Props: `run` (`{ type, description, status, toolUses?, durationMs?, summary?, model?, progress? }`, e.g. `cerebro-researcher`, "Find every open risk on the Phoenix cutover"), `title`, `statusText`, `error` (Claude Code's words), `open`, `defaultOpen`, `onOpenChange`, `children` (its steps, drawn by the caller as trace rows).
- The line: the task, a secondary Badge with its kind (`n-100` fill, `n-800` ink; none when unnamed), then facts "9 tool uses · 48s". It never shows tokens.
- Running: it opens, lights the title and shows what it is doing now under the line ("Reading records/risks/risk-scanner-delivery.md"). Done: "Done" is spoken and it closes unless the reader chose.
- Opened: an error block (danger ground), the model as an outline Badge, the steps, then the result in `text-primary`, line breaks kept.
- No steps says why: "It used no tools", or "Steps not recorded" for a run that ran; a running or never-run one says nothing.
- A failure's first three lines show under the closed line in `danger-700` at `fs-meta`; opened, the whole of it.
- `SubagentHandoff` titles: "Handing to release-scout", "Handed to release-scout" (a button opening its run, `arrow-up-right` after), "Couldn't hand to release-scout" with the refusal under it, "Denied the hand-off to release-scout". Icon `forward`.
- Facts appear only as recorded (CV-05): no `toolUses` or `durationMs`, no facts. Presentation only (CV-64).
