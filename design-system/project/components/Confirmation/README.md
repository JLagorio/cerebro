# Confirmation

A question before something runs or changes: what is asked, who asks, what it would touch, and the answers.

- Use it for every card that asks: the assistant's permission, ask-first write and question cards, and Review's queued writes and proposals. Each keeps its own words and test hooks; build no other asking card.
- Props: `state`, `title` ("Run this command?", "Change this file?", "A question for you"), `icon`, `summary` ("The assistant is waiting for your answer.", "Scout asks before writing"), `meta` (who queued it, when), `children` (what it would touch), `notice`, `refusal`, `outcome`, `approve`, `deny`, `variant` (`default` asking ground, `outline` hairline for Review), `testIds`.
- `state`: `pending` waits for the person; `answering` offers nothing to press while an answer is on its way; `answered` shows `outcome` in place of the answers ("Applied — inbox/dock-call-notes.md"); `stale` cannot be answered and its notice says why ("No longer waiting: …"); `refused` still waits, under the refusal that came back (`role="alert"`).
- `approve`: one or more `ConfirmationChoice` (`label`, `onClick`, `variant`, `icon`, `disabled`, `testId`); the first is primary ("Allow once", then "This conversation"). `deny`: `label`, `onDeny(reason | null)`, and an optional `reason` (`label` "Why not? (optional)", `required`, `when` `always` or `on_deny`). With neither, the body answers (a `Questionnaire`).
- `ConfirmationSubject` shows a command or path verbatim in `font-mono` `fs-2xs` on `n-0`, `border-subtle`, `r-md`, scrolling past 160px. Whatever an agent wrote is drawn as text, never markup.
- Built on `Item` (`outline`, `sm`): `r-lg`, `sp-3` padding; title semibold `text-primary`; meta and notice `text-meta` at `fs-meta`; outcome `n-700` 500. Answers are `sm` `Button`s 6px apart.
- The asking card wears the brand's quiet ground, not synapse: `cortex-50` with a `cortex-200` border and a `cortex-600` icon; refused turns the border `danger-200` and the refusal `danger-600`.
- It only asks (CV-28): a run waits and only a person answers; the answers are the caller's, minted by its answer command.
