# Message

One turn of a conversation: the person's words in a filled bubble at the end, the agent's reply as prose at the start, and the turn's actions under it.

- Use it for every turn the assistant, a run's transcript or a comment thread's @agent turn draws. `from` is `user` or `assistant`; `align` overrides where `from` puts it (a thread's people sit at the start).
- Parts: `MessageGroup` (consecutive turns from one speaker), `Message`, `MessageAvatar` (`name` for initials, a vault or data `src`, or an icon as children; decoration, hidden from assistive tech), `MessageContent`, `MessageHeader` (who, when), `MessageFooter` (actions, "Worked for 1m 5s"), `Bubble` with `BubbleContent`, `MessageActions`, `MessageAction`.
- `Bubble` variants: `default`, the person's (`action-primary` with `on-action-primary`); `muted` (`n-50`, `text-primary`); `ghost`, no fill, for prose. Content pads 10px x `sp-4`, radius 18px, `fs-md` at 1.65, keeps line breaks, at most 88% wide.
- `MessageToolbar` draws, in order, Copy (given `copy` text), Retry, Edit, Save answer and Branch from here, each only when it has a handler; `branchLabel` names Branch for its turn. Copy says how it went to the eye and to a screen reader. There are no Good or Bad toggles: nowhere records them.
- Tokens: rows gap `sp-2` at `fs-ui`; header and footer `text-meta`, `fs-xs` 500; actions are small `IconButton`s, 2px apart, in `text-meta`; the avatar is 28px, `r-full`, its icon in `text-ai`, the one synapse token here (AI surfaces only).
- The person's text and the agent's words are drawn as text. Markdown rendering is the caller's (`MessageMarkdown`), handed in as children.
- Presentation only (CV-64): `ChatTurn` builds the turn from the transcript; the element reads no store, IPC or agent model.
