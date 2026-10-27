# M94.2 — Composition sheet

The owner accepted the refined treatment on 2026-10-25 for wider collection
and utility adoption ([decision](../2026-10-25-m94-refined-composition-decision.md)).
Fonts, colors, control sizes and stored display preferences retain their existing owners.

| Role | Reading order | Insets and type | Exceptions |
| --- | --- | --- | --- |
| Document | 64px toolbar → projected first H1 → review/properties → tabs → authored body | Existing 40/48 title, 16/28 prose; 880px outer readable surface retained while resolved prose is measured | Guarded concept title, Agent tabs, full-width embeds and single side-panel slot retain current ownership |
| Collection | 28/36 heading and primary action → description → shelf/view controls → search → rows/cards/data | Top 40px, header bottom 24px; pane-based horizontal inset below | Data gets the available width; no prose measure or global row-height change |
| Utility | 24/32 heading and task action → short description → grouped fields → field state → repair/Done/Cancel | Top 32px, header bottom 20px; pane-based horizontal inset below | Compact inspectors remain 13/18; diagrams, whiteboards, sheets, timelines and quiet Home keep task-specific geometry |

## Shared horizontal contract

The `.cb-composition` ancestor is a named inline-size container. Both the
opt-in `PageHeader` and `.cb-composition-content` measure that container,
not the viewport or the header's own padded box.

| Actual host width | Left/right inset | Verified boundary pair |
| --- | --- | --- |
| Below 600px | 16px | 360px and 599px |
| 600–959px | 24px | 600px and 959px |
| 960px and above | 32px | 960px |

Heading, description, control group and content start at the same edge. A long
heading lets actions wrap rather than hiding them or widening the window.
The measured edge tolerance is 2 CSS px; it is not an aesthetic score.
Existing `variant` behavior is unchanged when `composition` is absent.

## Concrete utility repair

The specimen shows the task heading, account-label field, an unavailable-check
message that explicitly retains the label/grants, and a local Retry control.
The unchanged primary button is 32px tall with a visible focus ring. The repair
message uses the existing state and border roles; it does not turn a failed
read into an empty inventory. Its controls only update specimen-local state.

## Density and corners

Button heights remain 28/32/36px; IconButton 24/28/32px; navigation 36px;
data rows 32/44/56px and data header 36px. The comparison list's one-line
rows use a 48px minimum, while long text wraps. The retained baseline shows
Pages' original 56px minimum; the first application comparison now uses 48px
with 28px file icons and uncropped multiline titles. Ordinary corners
remain the existing 6–8px controls and 10–14px cards/menus. No radius or
color-token migration is part of this slice. The document canvas keeps its
single top-left corner and existing pane budget.

## Remaining comparisons

Actual first-slice application captures must compare the same long/nonleading
H1 document, twenty-property record, twelve-item Pages list/grid and populated
table, including a refused field and filename fallback. Document prose measure,
Pages 48px versus 56px rows, narrow panels, 200% zoom and four-pane parking
remain separate interaction/owner acceptance. The specimen alone closes none
of those application journeys.
