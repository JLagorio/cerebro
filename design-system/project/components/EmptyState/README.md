# EmptyState

The centred state for a read that succeeded and found nothing.

- Use it only for a measured empty: an empty Inbox, a view with no records, a filter that matches nothing. A read that failed is `StateMessage` with `state="unavailable"`, never this (CV-05).
- Props: `title`, `icon` (Lucide name, default `inbox`), `description`, `action` (one node, usually a secondary `Button`), `compact`, `style`, `className`.
- Icon well: 48px (36px when `compact`), `r-lg`, `n-50` with an `n-100` border, 8px above the title, holding a 20px (16px) Lucide icon at 1.5 stroke in `n-400`.
- Title: `section-title` 600 with `track-tight` in `n-800` (`text-ui` when `compact`).
- Description: one helper line, `text-ui` in `text-muted`, at most 340px wide, 1.5 leading.
- The action sits 12px below the description. At most one.
- Padding 56px x 24px, or 24px x 16px when `compact` (panels, sidebars); items 4px apart, centred.
- The description teaches the model or names the next step ("Captures land here untyped…", "Adjust the filters in view settings to widen the query."), never "Nothing to see here".
- Point only at a control that exists on this surface: say "Create the first one below" only where an add row is drawn.
