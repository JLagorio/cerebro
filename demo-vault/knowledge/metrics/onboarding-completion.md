---
type: Metric
title: Onboarding completion
description: Share of new accounts that finish guided onboarding within 14 days.
tags: [onboarding, activation]
lifecycle: stable
generated: { by: claude-code/2.0, at: 2026-07-24T10:12:00Z }
verified:
  - { by: process:metrics-nightly, at: 2026-07-26T02:00:00Z }
  - { by: human:josef, at: 2026-07-26T09:15:00Z }
usage_window: { from: 2026-06-01, to: 2026-06-30 }
sources:
  - id: kr-onboarding
    resource: /records/key-results/kr-onboarding-completion.md
    title: KR — Onboarding completion
    author: human:maya-chen
    last_modified: 2026-07-22
  - id: ga-dashboard
    resource: https://example.com/dashboards/onboarding
    title: Onboarding funnel dashboard
    usage_count: 1840
    last_modified: 2026-07-25
---

# Definition

An account counts as **completed** when it has finished every required step
of guided onboarding within 14 days of first login.[^kr-onboarding]

| Term | Meaning |
|------|---------|
| `new account` | First successful login in the period |
| `completed` | All required onboarding steps done |
| `window` | 14 days from first login, not calendar month |

# Why 14 days

The 14-day window was chosen because the funnel dashboard shows completion
effectively flat after day 12 — a longer window adds noise, not signal.[^ga-dashboard]

# Caveats

Accounts created by the sales team during a migration are excluded; they
skip guided onboarding entirely and would otherwise depress the number.

[^kr-onboarding]: KR — Onboarding completion
[^ga-dashboard]: Onboarding funnel dashboard
