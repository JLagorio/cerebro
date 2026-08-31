---
type: Collection
icon: rocket
color: '#3D8BE8'
order: 1
---

# Delivery

Everything in flight, and the shape of the month. The three views below are
the same Work item database seen three ways — the schedule is the one to open
when someone asks whether a date is real.

```cerebro-database
database: Work item
view: at-risk-work
```

Anything urgent that is still moving. If a row sits here for two weeks it is
not at risk, it is stuck, and it wants a decision rather than a status.

```cerebro-database
database: Work item
view: delivery-schedule
```

Bars are real spans, not deadlines, and the arrows are the `blocked_by`
claims the records already make. A red arrow means the data contradicts
itself: the thing being waited on does not finish before the thing waiting
starts.

```cerebro-database
database: Work item
view: this-month
```
