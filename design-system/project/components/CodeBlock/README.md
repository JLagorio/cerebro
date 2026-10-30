# CodeBlock

Code, terminal output and diffs on a sunken card, with an optional header, line marks and a copy button.

- Use it for code in a reply, a tool call's input or result, and a patch. `Terminal`, `TestResults` and `StackTrace` draw their output with it.
- `CodeBlockContent` takes either plain children (cheap while output streams) or `code` with `language` and `theme: 'light' | 'dark'`, which it highlights with the app's Shiki. The theme is always the caller's prop; nothing here reads the app's.
- `language="diff"` tints added lines `success-50` and removed lines `danger-50`; `ansi` drops escape codes. Past 20,000 characters, or for a language with no grammar, it draws plain text.
- Parts: `CodeBlock` (`variant`: `default` or `destructive`; `size`: `default` or `sm` for a trace); `CodeBlockHeader` with `CodeBlockTitle` (truncates, optional icon) and `CodeBlockActions`; `CodeBlockFooter` for a note under the code; `CodeBlockLine` (`added`, `removed`, `highlighted`).
- `CodeBlockActions` placed straight in the block, with no header, float over its corner and show on hover or focus, always on touch.
- `CodeBlockCopyButton`: `value`, and a `label` that tells blocks apart ("Copy the code", "Copy the error"). It says "Copied" or "Couldn't copy", to the eye and to a screen reader.
- `wrap` wraps long lines; otherwise they scroll. `lineNumbers` and `startLine` number the lines as a counter, left out of a copy.
- Tokens: `surface-sunken` with an `n-100` hairline at `r-xl` (`r-lg` small), `font-mono` at `fs-sm` (`fs-xs` small), line height 1.6, padding `sp-4` (`sp-3`); header ink `text-meta` with the title in `text-primary` at `w-medium`; destructive is `danger-50`, `danger-200`, `danger-700`; focus is `border-focus` plus `ring`.
- Use `destructive` for errors and failed output only, never for a diff's removals.
