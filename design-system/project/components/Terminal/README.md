# Terminal

A command the agent ran: one line in its state's tense that opens onto the command as typed and what it printed.

- Use it for a shell call that has no test summary; a run whose runner printed one draws as `TestResults` instead, with a `StackTrace` hung under a failed one.
- Provide `status` (`running`, `done`, `failed`, `interrupted`, `waiting`, `cancelled`, `not_run`, `paused`, `denied`), a `title` sentence in that tense ("Ran a command", "Failed to run a command"; the command as a mono target after it), `command`, and `result: ShellResultData` (`{ type: 'shell', stdout, stderr, interrupted, truncated }`). `description` takes a recorded duration ("41s").
- The line is `StepHead`: state icon or yours (`terminal`), the title, then facts. Interrupted, waiting, cancelled, not-run and paused steps also write their sentence under the title ("Interrupted, may have completed").
- The detail is a small `CodeBlock`: `$ ` drawn before the command (left out of a copy), stdout, then stderr ruled off in `danger-200` and set in `danger-700`. A copy button takes both streams.
- Output arrives whole when the call returns. A running command opens by itself only once it has output; until then it says "No output yet", never a fake cursor.
- An empty stream says which empty it is: "No output", or "Output not recorded" for a call that ran with nothing kept (CV-05).
- A cut head says "Showing the last part of the output"; an interrupted call ends with "Interrupted before it finished" in `warn-700`.
- Long output scrolls inside the block at `16rem`; the block wraps its lines.
- Tokens: `surface-sunken` block with an `n-100` hairline at `r-lg`, `font-mono` at `fs-xs`; notes in `text-meta` and `font-ui`; command in `text-primary` at `w-medium`.
