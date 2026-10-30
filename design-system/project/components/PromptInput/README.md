# PromptInput

The field the person writes to the agent in: one pill holding the files, the text, the tools and the send button that becomes Stop while a turn runs.

- Use it as the assistant's composer, inside `Chat`'s `composer`, in every presentation (floating, docked, canvas); its children keep their places so the textarea stays the same node.
- `PromptInput` props: `onSubmit` (Enter and the send button both call it; refusing an empty draft is the caller's, by disabling Send), `disabled`. It is not a `<form>`: sending is a call, never a submit event.
- Parts: `PromptInputHeader` (attachments, across the top), `PromptInputBody`, `PromptInputTextarea` (grows to `min(112px, 18dvh)`, then scrolls; placeholder "Ask anything…" or "Work with this page…"), `PromptInputFooter`, `PromptInputTools` (the `ModelSelector` and `Context`), `PromptInputButton` (an `IconButton` whose label is its tooltip: "Add context", "Add to Up next"), `PromptInputSubmit`.
- `PromptInputSubmit` `status`: `ready`, `submitted`, `streaming`, `stopping`. With `onStop`, a running turn's button is Stop (a square); without it, it still sends and the caller queues. `stopping` reads "Stopping…" and waits. Its name is always the word.
- Keys live on the textarea, never the window (CV-47): Enter sends, Shift+Enter breaks the line; `submitOn="mod+enter"` for paragraph fields such as a comment. An Enter that ends an IME composition never sends; a caller's `onKeyDown` that prevents Enter (a completion menu) keeps it.
- A press anywhere else on the pill puts the caret in the field.
- Pill: radius 24px, min 56px tall, `sp-3` padding, `surface-raised`, `border-subtle`, `border-strong` while focus is inside. Text `fs-ui` on a 24px line, placeholder `text-placeholder`, disabled `text-disabled`.
- Send: 32px round, `action-primary` with `on-action-primary`, `action-primary-hover`, `action-primary-press` with scale .94; disabled at 50%; focus a `border-focus` outline.
- Presentation only (CV-64): the draft, the files and the run's status are the caller's.
