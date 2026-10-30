# Calendar

The one month-grid calendar every date surface uses: a header with month, Today and arrows over a six-week day grid, with all state held by the caller.

- Use it inside a date surface (`DatePicker` composes it); it draws no panel, border or shadow of its own, and fills its container's width.
- The consumer provides `month` (`YYYY-MM`) with `onMonthChange`, `start` and optional `end` (ISO dates; a single date is `start` alone), and `onPick(date)`. A range is ordered for display whichever endpoint is earlier.
- `onToday` adds the quick-jump button; `todayLabel` defaults to "Today" (DatePicker passes "Now" when time is shown).
- Header: month name and year in `fs-sm` semibold `n-900`; the Today button is `fs-xs` `n-500`; the arrows are 24px `r-md` buttons with 14px chevrons, `n-50` on hover.
- Weekday row: Su to Sa in `fs-xs` `text-meta`, 28px tall. Weeks start on Sunday.
- Days: 42 buttons, 32px tall, `fs-sm`; `n-800` in month, `n-300` for neighbours, `n-50` on hover, `r-lg`.
- Endpoints fill with `action-primary` and `on-action-primary` ink at weight 500; days between them are a square `cortex-100` band.
- Keyboard: one tab stop (roving tabindex), arrows move by day and week, Home and End to the row's ends, Page Up and Page Down by month. Focus never moves on mount.
- Each day's accessible name is its full date, not the bare number. `shiftMonth` and `monthGrid` are exported helpers.
