# DatePicker

The date panel for a property, chip or filter: date boxes over the shared `Calendar`, then rows for end date, format, time, timezone and reminder.

- It is the open panel itself, a controlled component; the caller anchors it in a popover (`FixedBelowAnchor`) and persists the value. The card shows the panel; its closed trigger belongs to the host.
- The consumer provides `value` (a `DateValue`: `start`, `end`, `startTime`, `endTime` in 24h `HH:MM`, `format`, `timeFormat`, `remind`), `onChange(next)` and `onClear()`. `today` (ISO) is injected for tests and relative formats.
- Hide what the storage cannot carry: `showEndToggle`, `showTime`, `showRemind` and `showFormat`, all `true` by default. A filter bound hides the end toggle and the format rows, which write to the type note and would change nothing there.
- Panel: 300px, `r-xl`, `n-200` border on `n-0`, 10px padding and a soft drop shadow (0 8px 28px).
- Date boxes: 32px, `r-lg`, `fs-sm`, written in `value.format`. The box being edited is `cortex-500` bordered on `cortex-50` with a 2px `cortex-100` halo; the other is `n-200` on `n-25`. With an end date, picks alternate between the two endpoints and the range keeps itself ordered.
- Setting rows: 32px, `r-md`, `fs-sm` `n-800` label, `n-500` value with a 13px chevron, `n-50` on hover; sections split by `n-100` hairlines. End date and Include time are `Switch`es.
- Date format, Time format and Remind open a 224px side flyout (`r-lg`, `shadow-lg`, check on the current row) that flips left near the window edge.
- With time on, each box gains a 92px native time input and the rows add Time format and the machine's Timezone; the Today button reads "Now".
- With reminders shown, a `text-meta` footnote says where reminders appear. Clear is its own row at the foot.
