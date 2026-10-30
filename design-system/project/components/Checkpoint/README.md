# Checkpoint

The marker between a reply and the next turn that starts a new conversation from that point.

- Use it after a reply the person may branch from. Which replies offer one is the caller's to decide (`panelCheckpoints`: an anchor, a thread that is not blocked, a readable transcript, a later message).
- Props: `turn` (how the button's name ends: "your message “Plan the Phoenix cutover”"), `onBranch`, `disabled` (a send in this thread is still starting), `triggerTestId`.
- Its words are fixed (`CHECKPOINT_WORDS`): "Branch from here" on the button and "Files stay as they are" beside it; the button's name is "Branch from here, after <turn>" and the note describes it.
- It branches, never restores: the new conversation holds the thread up to that turn, and files later turns changed keep their changes. Never label it "Restore".
- Parts: `Checkpoint`, `CheckpointIcon` (a hidden `git-branch` glyph, 12px), `CheckpointTrigger`.
- A labelled divider, not a `separator`: `border-subtle` 1px rules either side, `text-meta` at `fs-meta`.
- Button: 22px, `sp-2` sides, `n-0` fill, `border-strong` hairline, `r-md`, `n-800` 500; `n-50` on hover; focus `border-focus` plus `ring`; disabled at 45%.
- Presentation only (CV-64): the caller opens the branch; the marker reads nothing.
