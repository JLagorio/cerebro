---
type: Spec
title: Phoenix cutover — go-live PRD
status: draft
owner: "[[marcus-webb]]"
project: "[[phoenix-warehouse-rollout]]"
---

# Phoenix cutover — go-live PRD

## Goal

Move the Phoenix warehouse onto the new stack in a single night, with a rollback path that can be taken at any point before receiving is unfrozen.

## Cutover window

We are planning a **four-hour window** starting at 22:00. That covers the freeze, the cut, the smoke set, and the unfreeze with room to spare.

## Offline behaviour during the cut

Crews keep working offline throughout. The app guarantees a **seven-day** offline window, so a four-hour cut is comfortably inside it and no crew should notice the transition.

## Scanning

Hardware is the risk to watch — if the scanners are not delivered we cannot go live.

## Open questions

* Who runs the smoke set?
* Do we need a second on-call for the warehouse floor?
