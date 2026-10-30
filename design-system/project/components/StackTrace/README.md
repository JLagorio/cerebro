# StackTrace

A failed call's error and the frames it was raised through, innermost first.

- Use it under a failed `Terminal`, in a turn's error notice, or anywhere a command printed a JavaScript, Rust, Python or Go trace.
- Provide `trace`: the error text exactly as printed. `engine/ai/stackFrames.ts` reads the frames from it; text with no trace in it is shown as the error it is, with no frames invented.
- `title` overrides the line ("Stack trace"); left out, it is "Failed: " and the error's first line, which truncates. It starts closed; `defaultOpen` or `open` opens it.
- Inside: the whole error in a destructive `CodeBlock`, the frames you can fix as lines ("restore in src/vault/trash.rs:141"), then the runtime and library frames folded into one line ("4 library and runtime frames") that opens onto them as printed.
- Pass `onOpenPath` so a frame whose file is a relative vault path is a button that opens it at its line (with an `arrow-up-right` mark); any other frame is text. Never an href (CV-16).
- A copy button under the frames takes the trace as printed.
- Tokens: the line in `danger-600` with `circle-x`; the error on `danger-50`, `danger-200` hairline, `danger-700` ink, `font-mono` at `fs-xs`; library frames on `surface-sunken` at `r-md` in `text-meta`, `fs-xs`/`lh-xs`, scrolling sideways rather than wrapping a path.
- Presentation only (CV-64): the caller hands it the text and the opener.
