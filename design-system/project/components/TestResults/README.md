# TestResults

A test run as its runner reported it: a line that counts what passed and failed, opening onto the totals, the failures first, then each suite.

- Use it in place of a `Terminal` when the command's output ends in a runner's own summary (vitest, jest, cargo, pytest, go, playwright).
- Provide `report: TestReport` from `engine/ai/testReport.ts`: `{ runner, totals: { passed, failed, skipped, total, durationMs?, files?, errors? }, failures: [{ name, message?, location? }], suites?, cut }`. `null` draws nothing, so the caller shows the command's output instead.
- Pass `onOpenPath` (and optionally `isVaultPath`) to make a failure's location a button that opens the file at its line; without it the location is text. Never an href (CV-16).
- The line reads "Ran 2192 tests, 2 failed, 6 skipped" with its duration, in danger ink when anything failed. A failing run opens by itself; a passing one stays closed and says "Passed".
- `TestResultsSummary`: badges "Passed: N", "Failed: N" (`destructive` when above 0), then "Skipped", "Errors" and "Failed files" only when they count something.
- `TestError`: one failure, open, its first error line in a destructive `CodeBlock` and where it was raised. `TestSuite`: a closed line per test file, its cases failed-first, each "Passed:" or "Failed:" in words, with its duration.
- When the summary counted more failures than the output still shows, it says so: "Showing 2 of 5 failures; the output no longer shows the rest."
- Absent is never zero (CV-05): output with no summary is no report, and never reads "0 failed". A suite carries no count of its own.
- Tokens: badges on `n-100` with `n-800` ink, destructive on `danger-50` with `danger-700`, `r-full`, `fs-xs`; failed lines in `danger-600`; error blocks on `danger-50` with a `danger-200` hairline; the cut note in `text-meta` at `fs-meta`.
