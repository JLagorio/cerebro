# Dropdown

The toolbar and config-row listbox button, kept under its older prop names; it renders `Select`, so it has one implementation and one look.

- Use it where a call site already speaks Dropdown (rollup, filter value, template pickers); new code may use `Select` directly. Never a native `<select>` (CV-63).
- The consumer provides `options` (`value`, `label`, optional Lucide `icon`), `value`, `onChange` and `label`, which becomes the trigger's accessible name (`ariaLabel` on `Select`).
- `size`: `sm` 28px (`control-h-sm`, `meta` 12/18, the usual choice in config rows) or `md` 32px (default, `control-h`, `ui` 14/20).
- `width` takes a number or CSS length; config rows use 200 beside an 86px `n-500` label column.
- `placeholder` shows in `n-400` while `value` matches no option, for a prompt ("Pick a relation…", "Choose…") or a deleted option. Without one, an unmatched value shows nothing rather than a row that is not the value.
- `disabled` greys the trigger to `n-50` with `text-disabled`.
- Trigger, list and keyboard are `Select`'s outline variant: `n-200` border on `n-0`, `r-md`, `n-800` value, a 14px chevron; the list is the menu surface (`r-lg`, `shadow-lg`) with 28–30px rows and a `cortex-600` check on the current value.
- Not exposed here: `ghost`, `searchable`, `invalid`, option `color`, `hint` or `disabled`. Reach for `Select` when a row needs them.
- The card shows triggers closed; click one to open its list.
