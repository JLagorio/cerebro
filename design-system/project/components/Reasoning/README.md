# Reasoning

The model's thinking as one line that opens onto the text: "Thinking" while it streams, "Thought for 12s" once done.

- Use one per thinking block in a turn, usually inside `ChainOfThought`.
- Props: `text` (the thinking as written), `isStreaming`, `durationMs` (from the timestamps of its lines), `redacted` (Claude Code withheld it), `open`, `defaultOpen`, `onOpenChange`.
- Titles (`reasoningTitle`): "Thinking" while streaming; "Thought for 12s" or "Thought for under a second" when measured; "Thought" when not (CV-05: never "Thought for 0s"); "Reasoning hidden by Claude Code" when withheld.
- Icons: `brain`; `eye-off` when withheld. Streaming lights the title with the working light; the title is the status, so it speaks no extra words.
- It opens while streaming so the thinking shows as it comes, and closes when done unless the reader chose.
- The text keeps the model's line breaks (`white-space: pre-wrap`) in `n-600` under the 1px `border-subtle` rule, line height 1.625.
- Finished thinking with no text draws nothing at all; withheld thinking is a plain line with nothing to open.
- Presentation only (CV-64).
