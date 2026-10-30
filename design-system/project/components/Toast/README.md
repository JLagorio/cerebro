# Toast

A notification card for the outcome of an action, raised through the app's one toast host.

- Raise one with the UI store's `toast(message, { action })`; `ToastHost` draws it. Render `Toast` directly only for a host or a demo.
- Props: `title`, `tone` (`neutral` default, `success`, `warn`, `danger`, `ai`), `description`, `action` (`{ label, onClick }`, one at most), `onDismiss`, `style`, `className`.
- Tone icons, 16px: `neutral` `info` in `n-600`, `success` `circle-check` in `success-500`, `warn` `triangle-alert` in `warn-500`, `danger` `circle-alert` in `danger-500`, `ai` `sparkles` in `synapse-500` (AI outcomes only).
- Card: 360px wide (at most the window less 32px), `n-0` on an `n-200` border, `r-lg`, `shadow-lg`, padding 12px 12px 12px 14px, 10px gap.
- Title `text-ui` 600 in `n-900`; description `meta` in `text-secondary`; the action is a link-styled `text-xs` 600 button in `text-link`, 8px below; a small `IconButton` "Dismiss" closes it.
- The host stacks toasts bottom-centre, 16px up, 8px apart, at `z-index` 1100. Each stays 6s, or 10s with an action; hover or focus on the stack pauses them; the action runs and dismisses its toast.
- Motion: arrives on `cb-toast` (`--motion-enter`, a 10px rise from scale .96); dismissed, it leaves as a fading copy (`cb-toast-leave`, `--motion-exit`) while the stack closes up.
- The title states the outcome in a few words ("Moved “Duplicate jobs after reconnect” to Trash", "Link copied"); a failure names what failed and why ("Couldn't move “Weekly review” to Trash: …"). Undo rides as the action.
- A human action never throws: it catches, toasts and returns `null` or `false` (CV-03). A proposal that comes back queued or rejected is a card the person must see, never a toast.
- The host owns the single `role="status"` live region; the toast itself carries no role.
