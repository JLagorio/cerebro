# Input

A single-line text field with an optional leading icon and a trailing suffix node.

- Use it for names, searches and filters in dialogs, popovers and property rows; a fixed choice is a `Select`, never free text.
- Sizes follow the control heights: `sm` 28px (`control-h-sm`, `meta` 12/18 text, 14px icon), `md` 32px (`control-h`, default, `ui` 14/20, 16px icon), `lg` 36px (`control-h-lg`).
- Shell: `n-0` ground, `n-300` border (`n-400` on hover), `r-md`, 10px side padding, 8px gap. Focus moves the border to `border-focus` and adds `ring`, on `dur-fast` (it reads as the ring arriving, so it skips the faster hover token).
- Text is `text-primary` in `font-ui`; placeholders are `text-placeholder` and say what goes in ("Folder name", "Search records…"), never "Type here".
- `icon` takes a Lucide name (`search` for filters), drawn in `n-500`, `n-600` while focused. `suffix` takes a node, typically `Keycaps` for a shortcut hint.
- `disabled` greys the ground to `n-50`, the text to `text-disabled`, and stops pointer events.
- The consumer provides `value` and `onChange`, plus `onKeyDown` (Enter to submit) and `onBlur` as needed. `width` takes a number or CSS length ("100%" in dialogs); `id`, `type`, `autoFocus`, `style`, `className` pass through and `testId` lands on the inner `<input>`.
- `ariaLabel` is required when no visible label names the field.
- A field that drives a list it does not contain passes `role="combobox"`, `ariaExpanded`, `ariaAutocomplete`, `ariaControls` and `ariaActivedescendant`, so Enter's target is announced.
