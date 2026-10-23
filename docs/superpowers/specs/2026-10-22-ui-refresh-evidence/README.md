# UI refresh review: evidence record

**2026-10-22 · documentation-only review.** This record supports the
[UI refresh plan](../../plans/2026-10-22-ui-refresh-plan.md) and
[four independent reviews](../../plans/2026-10-22-ui-refresh-review/README.md).
It separates a fresh failed startup observation from retained visual material.
No application source was changed to obtain captures.

## Fresh browser attempt: blocked before rendering

The coordinating review followed the repository's
[verify-ui skill](../../../../.claude/skills/verify-ui/SKILL.md): a separate free
port, mock/demo vault, the actual [E2E boot helper](../../../../e2e/boot.ts), fixed
fixture clock, light theme and automatic learning disabled. A scratch Playwright
script outside the repository launched Chromium against a Vite server at
`http://127.0.0.1:5317/`. Port 5173 and the owner's browser were not used.

The first attempt timed out awaiting the demo-vault opener or application rail.
A diagnostic retry captured an empty body and a page exception. The final
bounded retry reproduced that same exception:

```text
shared/policy/tool-approval.v1.json: unknown field `agent_types`
```

| Observation                                   | Value                                                   |
| --------------------------------------------- | ------------------------------------------------------- |
| Final attempt                                 | 2026-10-22 23:28:19–23:28:30 UTC / 16:28 PDT            |
| Browser                                       | Chromium 149.0.7827.55                                  |
| Viewport                                      | 1440×1000 CSS pixels                                    |
| Browser timezone / fixture clock              | UTC / 2026-07-28T12:00:00Z                              |
| Theme / motion                                | Light / reduced motion                                  |
| Host                                          | Node 24.14.0; pnpm 9.15.9; Vite 7.3.6                   |
| Boot result                                   | Failed; expected opener or rail absent after 10 seconds |
| Rendered body                                 | Empty                                                   |
| Native application / CLI / provider exercised | No                                                      |

The host Node/pnpm versions differ from repository pins. This observation is
not a supported-toolchain validation or a full E2E run. The concrete page
exception matches the strict policy field check inspected in source; startup
must be repeated on a coherent M91 handoff and the supported toolchain.

Retained artifacts:

- [Final structured browser report](browser-check.json), including post-observation
  hashes for policy artifacts, loaders and selected frontend seams.
- [Diagnostic retry capture](startup-policy-error.png).
- [Final retry capture](startup-policy-error-final.png).

The PNGs are blank failure captures, **not UI baselines**. They do not establish
visual quality, responsive behavior, contrast or native behavior. The exact
source mismatch and remaining M91 integration work are documented in the
[architecture recheck](../../plans/2026-10-22-ui-refresh-review/01-architecture-recheck.md).
Do not interpret an in-progress policy/loader pair as a shipped-release result.

## Historical Cerebro images actually inspected

These retained October 17 captures informed composition review. They are linked
in place rather than duplicated or relabeled as current. October 19 toolbar,
sidebar, panel and assistant changes postdate them; current source controls
claims about those contracts.

| Retained image                                                                                     | What it helps inspect                                 |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [Full record](../2026-10-17-polish-implementation/P02-record-fullpage-chromium.png)                | Content/title/property hierarchy and page composition |
| [Light table](../2026-10-17-polish-implementation/data/table-light-chromium.png)                   | Working density, headers and data emphasis            |
| [Dark board](../2026-10-17-polish-implementation/data/board-dark-webkit.png)                       | Card hierarchy and dark surface separation            |
| [Writing selection](../2026-10-17-polish-implementation/editor/writing-selection-light-webkit.png) | Prose measure, editor controls and selection context  |
| [Library](../2026-10-17-polish-implementation/W02-library-light-webkit.png)                        | Collection header, cards and surrounding navigation   |

Reference images and source observations used by the visual reviewer are linked
in the [visual-system dossier](../../plans/2026-10-22-ui-refresh-review/02-visual-system.md),
including Tolaria light/dark views, Plane's Pages onboarding image and an AppFlowy
desktop guide image. Plane's onboarding image is a promotional crop. None is
evidence that the reviewed reference app was run in this session or that its
current release behaves as the image suggests.

## What still needs evidence

Once startup is coherent, capture the same populated documents, records and
views before and after the proposed changes. Record source/build identity,
viewport CSS size, device scale, actual pane width, zoom, theme and corpus. Use
the [acceptance matrix](../../plans/2026-10-22-ui-refresh-review/04-acceptance-challenge.md)
for complete journeys and separate native/performance requirements.

The review does not supply fresh rendered-app screenshots, a new visual design
implementation, reference-app interaction tests, measured color contrast,
current scale benchmarks, CLI/provider execution or native acceptance. Those
limits are carried into the delivery plan rather than converted into passes.
