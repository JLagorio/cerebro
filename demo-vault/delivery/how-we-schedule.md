# How we schedule

A doc living inside a Collection, next to the Lists it describes — which is the
point of the container. Before M10 a saved view was both the container and the
query, so there was nowhere to put this: it would have had to become a record in
some list, or float loose in the vault away from the thing it explains.

## Windows, not deadlines

`due` is a deadline — one day. `window` is a **daterange**, the span of actual
work. The Gantt keys on `window` so a bar covers the work rather than sitting on
the date it is owed, and the Calendar shows a multi-week window as a band across
those weeks instead of one chip on its start date.

## Blocking is a relation

`blocked_by` on a Work item points at what it waits on. The Gantt draws those as
arrows and turns one red when the predecessor does not actually finish before its
successor starts.

It is never inferred. A guessed relation would draw a critical path the data does
not claim, and a schedule that invents its own constraints is worse than one that
draws none — so `dependencyField` has to be stated on the List.

## Nesting is grouping

There is no hierarchy view. A relation level in a List's grouping chain nests its
records, so any of the six views can show a hierarchy: group the delivery table
by `status`, then descend `blocked_by`, and you get bands of status each holding
its own dependency tree.
