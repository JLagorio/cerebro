# Tool

One tool call, from input to output: a line in its state's tense that opens onto its input, its result or error, and its actions.

- Use it for every call the manifest renders as a `step` or `change`; Terminal, Subagent, Test Results and Stack Trace draw their lines the same way.
- Props: `status` (a StepLine state), `title` (the manifest's phrase in the state's tense plus the call's target: "Edited a note ops-9.md", "Failed to edit a note", "Denied: Bash"), `statusText`, `icon` (the manifest's: `file-text`, `replace`, `terminal`; `plug` for a connector; default `wrench`), `description` (a recorded duration), `server`, `input`, `inputNote`, `output`, `outputNote`, `theme` (`light` or `dark`, for JSON highlighting), `actions`, `children`.
- Parts: the `StepHead` line; `ToolInput` ("Input"), `ToolOutput` ("Result", or "Error" on a danger ground when `status` is `failed`), each a small CodeBlock with a copy button; `ToolServer`, an outline Badge naming the connector a foreign call ran on; actions (Open, View diff) under the detail, never in the line.
- JSON input and output are laid out and highlighted when `theme` is passed and under 20,000 characters; anything else is plain text. Long blocks scroll inside 16rem.
- Blocks: `surface-sunken` ground, 1px `n-100` border, `r-lg`, `fs-xs` mono. Error: `danger-50` ground, `danger-200` border, `danger-700` ink. Server chip: `border-subtle` outline, `n-800` ink, `r-full`.
- A call with no input, output or actions is a plain line. It starts closed; open a failed one with `defaultOpen`.
- A write keeps its path visible on its line (the caller's target, in `cortex-700`), since it is the thing you might undo.
- An error arrives as words: unwrap Claude Code's `<tool_use_error>` tags first. A call a stopped turn left says "Interrupted, may have completed", never "Failed to run".
- Leave an unrecorded duration out, never `0` (CV-05). Presentation only (CV-64).
