---
type: Decision
status: accepted
decided: 2026-07-08
deciders:
  - "[[elena-vasquez]]"
  - "[[lena-ortiz]]"
  - "[[ana-rios]]"
affects:
  - "[[field-app-launch-campaign]]"
supersedes: "[[dec-one-app-not-two]]"
---

# Supervisors get a web console

## Context

Six weeks of usage data: supervisors open the app on a phone under 4% of sessions, and every scheduling action they take is followed by a desktop login.

## Decision

Split the supervisor experience into a web console. The mobile app narrows to crew work only.

## Consequences

Two surfaces to maintain, and a much smaller mobile app. The launch campaign's messaging has to change, which is why [[risk-messaging-unvalidated]] is still open.
