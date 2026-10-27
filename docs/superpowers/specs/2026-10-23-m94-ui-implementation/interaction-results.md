# M94 — Browser interaction results

Current status, 2026-10-26: the owner approved the refined treatment; see the
[composition decision](../2026-10-25-m94-refined-composition-decision.md).
The historical first-slice observations below retain their original pending
disposition. Wider adoption and the embedded database/control repairs are
tracked in the [implementation record](../../plans/2026-10-23-m93-m99-implementation-record.md).
The latest theme/focus journey passes Chromium and WebKit, including unchecked
row/header keyboard focus and stable editor identity across theme changes.
Packaged native, VoiceOver, IME and actual zoom acceptance remain open.

## Original first-slice observations

These observations cover the opt-in composition contract, not the complete UI
milestone. Browser: local Playwright Chromium; dev Vite on port 5392; synthetic
fixtures; 1440×1000 viewport, CSS zoom 1, pinned fonts and reduced motion.

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| Missing role behavior | Expected RED: 8px heading-inset mismatch at 360px | `/tmp/cerebro-m94-composition-red.log` |
| Collection and utility geometry | 4 tests passed, 25.0 seconds; each tests 360/599/600/959/960px | `/tmp/cerebro-m94-composition-green.log`; edge tolerance 2px, 32px action, wrapping/scroll containment |
| Light/dark samples | 20 captures retained; initial 600px collection light and 360px utility dark inspected | `/private/tmp/cerebro-m94-composition-green-captures`; remaining visual inspection recorded with manifest |
| Scoped ESLint | Passed | `/tmp/cerebro-m94-composition-lint.log` |
| Full current typecheck | Passed for this slice | App, tools and engine; final integrated release gate remains open |
| Current four-surface captures | 2 tests passed; six scenes per theme | Long nonleading-H1 document, twenty-property record, record with panel, twelve-item Pages list/grid, populated grouped table |
| Owner aesthetic disposition | Pending concrete paired first slice | No wider adoption yet |
| Native/VoiceOver/IME/actual zoom | Unverified | Must retain distinct evidence |

No screenshots were used to update existing golden snapshots. The recorded
baseline predates application adoption. Pages is now the first application
comparison, with aligned collection edges, 32px controls, 48px one-line rows
and naturally wrapping longer titles; its separate verification is in progress.

The final combined Chromium run passed **8 tests** and failed **2 existing
surface checks** (`/tmp/cerebro-m94-comparison-final.log`, 1.1 minutes).
All six new composition/baseline tests and both existing My work cases passed.
Library's light golden expected 872px height but observed 862px; its dark case
timed out finding the sidebar's New button. Current navigation assigns the
global launcher to the rail. Those failures need explicit fixture/source
attribution; neither is removed from the result or closed by the new tests.

The [capture manifest](capture-manifest.json) records 52 image/geometry artifacts
and before/after hashes of 2,632 source/configuration files. Four unrelated
source/test files changed concurrently during the run. The composition module,
shared header/CSS and baseline fixture hashes stayed stable, but this was not
an immutable production build and is not represented as one.

## Pages application comparison

The second Pages candidate passed **14 cases in 57.9 seconds** across Chromium
and WebKit (`/tmp/cerebro-m94-pages-candidate2.log`). Coverage includes Back visit
restoration, Favorites and recent pages, modified-click/Shift+Enter opening beside,
all five read states, full long titles at a 360px content host, reachable controls
at CSS zoom 2 and unchanged source bytes after browsing. The wide-header assertion
measures search and New on the same line. The narrow-title assertion checks the
actual hit target at its center, so an open drawer cannot conceal a passing box.

The first candidate passed its tests but failed visual inspection: search and New
wrapped unnecessarily at wide widths, and the narrow screenshot was obscured by
the context drawer. Its [original evidence](pages-first-slice-manifest.json) is
retained as a rejected comparison. Candidate 2 constrains the action group and
closes the drawer in the content-host fixture. No stored preferences were changed.

Concurrent M92 tests replaced the shared Playwright results directory during the
first successful candidate-2 run. A separate output-directory capture run passed
**10 cases in 37.3 seconds**; its [manifest](pages-candidate-2-manifest.json) retains
38 image/geometry artifacts. The wide Chromium list and narrow WebKit title were
visually inspected: inline search/New, readable three-line title, visible focus,
and no hidden content behind the drawer. These are fixture-browser observations,
not native or owner aesthetic acceptance.

The existing record-page case initially timed out waiting for its projected title
in a combined run (three other cases passed). Its isolated Chromium rerun passed
in **16.7 seconds** (`/tmp/cerebro-m94-record-isolated.log`); the WebKit case had
already passed in the combined run. The initial timeout is retained in
`/tmp/cerebro-m93-source-m94-record-final.log` and is not silently removed.

The measured document title/prose width is already **708px** inside the retained
880px outer surface, within the proposed 700–760px range. No outer-width change is
justified by this measurement. The current grouped table remains the comparison
baseline; density, frozen columns and refusal placement retain their existing
owners. Source-presentation controls received a separate alignment/affordance repair
after the save-race review; its final evidence follows below.

## Source presentation and save status

Four new geometry cases initially failed by54px on pages and28px on peeks. Shared28px buttons now align within2px, retain selected state and keyboard focus, and preserve exact source bytes. Final Chromium run passed **6 cases in1.3 minutes**, including the two existing source-body cases. The no-op roundtrip advances beyond debounce and asserts no write or false Unsaved status. [Nine retained images](source-controls-manifest.json) record full-page/peek and light/dark presentations. The final rich page light and source peek dark images were inspected.

The false status was separately reproduced with zero writer calls and no unresolved owner. Removing the redundant generic dirty callback leaves the retained owner's status authoritative. **111 focused unit tests** and the full app/tools/engine typecheck passed. Scoped ESLint passed. Native and actual accessibility/zoom acceptance remain open.

## Independent review

The bounded first slice and no-op save-status followup passed independent specification and quality review with no blocking findings. The reviewer inspected11images, the recorded tests and all manifests; all17frozen source hashes remained unchanged. Wider composition adoption awaits the owner comparison required by UX-04.

Test output retains known harness warnings: React act warnings and Node localStorage configuration in the focused unit log, and conflicting color environment variables in Playwright. These did not fail the checks; they remain cleanup items for the final integration gate. This record does not call that output pristine.
