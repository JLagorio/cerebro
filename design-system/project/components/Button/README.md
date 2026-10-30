# Button

The action button: one primary per view, graphite not blue.

- **Variants**: `primary` (default action of a view, `action-primary` fill with `on-action-primary` label), `secondary` (the default variant: `n-0` fill, `n-300` border, `n-800` label), `ghost` (toolbar and inline actions, `n-600` ink with an `n-50` wash on hover), `danger` (destructive confirm, `action-danger`).
- **Sizes**: `sm` 28px (`control-h-sm`, 12px label, 14px icon), `md` 32px (default, `ui` 14/20), `lg` 36px (14px label, 16px padding).
- Label: weight 500, sentence case, verb first ("Publish", "Delete"). Optional leading Lucide `icon` (kebab-case name).
- Radius `r-md`; focus is `border-focus` plus `ring`; disabled is 45% opacity. Pressed it gives to `scale: .98` on the pop pair.
- The consumer provides `children`, `onClick`, and for icon-only actions uses `IconButton` instead. `testId` forwards to `data-testid`.
- Don't: a second primary in one view; `danger` for anything that can be undone without loss; a blue filled button.
