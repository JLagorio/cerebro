# Attachment

A file on a message: its kind or its picture, its name and a line about it, and a button that takes it off.

- Use it for the composer's files above the text (`size="sm"`, in the `PromptInputHeader`) and for files shown on a sent message.
- `data` (`AttachmentData`): `id`, `label` (the name as read), `path` and `rootId` (`'0'` is the vault) when it is in a root, `kind` when the caller knows better than the extension, `description` ("Markdown", "Spreadsheet · copied in when you send", "Copying into attachments/…", or why it failed).
- `state`: `idle` (waits for the send, dashed border), `uploading` and `processing` (the name shimmers), `error`, `done` (default). `size`: `default` or `sm`. `onRemove`: without it there is no remove button.
- Parts: `Attachments` (a wrapping list), `Attachment` (draws all three parts when given no children), `AttachmentPreview`, `AttachmentInfo` (`showDescription`), `AttachmentRemove` (named "Remove <label>" unless given a `label`, such as "Remove cutover-prd.md from context").
- The kind's icon comes from the file-kinds table by name. An image in a root shows the thumbnail the caller draws through `thumbnail`, its `FileThumb` (CV-61); the element draws no picture itself.
- Chip: `surface-raised`, `border-subtle`, `r-lg` (`sm` `r-md`), `sp-1` padding, `fs-xs`; the name 500, the line `text-meta`; preview 32px (`sm` 24) on `n-50` in `text-meta`; focus within turns the border `border-focus`.
- Error: border `danger-200`, preview `danger-50` with `danger-600`, the line in `danger-600`. Keep the reason in the description so the state is never colour alone.
- Presentation only (CV-64): `composerFiles` (`agent/elements/attachments.ts`) builds the data and states; the element reads no store and calls no IPC.
