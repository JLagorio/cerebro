# Questionnaire

The agent's questions answered on one page: each a fieldset of options, Other in the person's words, and Send once every question has an answer.

- Use it as the body of the question card: a `Confirmation` titled "A question for you" with the `message-circle-question-mark` icon and no answers of its own.
- Props: `questions` (`QuestionSet`: each `question`, `header`, `options` of `label`, `description`, `preview` or null, and `multiSelect`), `onSubmit(answers)` (one `QuestionAnswer` per question: `question`, `picked`, `other`), `onDecline(message | null)` (without it there is no "Don't answer"), `disabled`, `submitLabel` ("Send answers"), `declineLabel` ("Don't answer").
- Every question is on the page at once, with no Skip, Previous or Next (a deliberate deviation from shadcn): Rust refuses a partial set, so Send waits until each question has an answer and never sends a partial one.
- Each question says what it still needs under it: "Pick one", "Pick at least one", "Type your answer or pick an option".
- Parts: `QuestionnaireItem` (a fieldset), `QuestionnaireTitle` (the header as a chip, clipped at 12 characters, then the question), `QuestionnaireChoices`, `QuestionnaireChoice` (a label over a native radio or checkbox, with its description), `QuestionnaireInput` (Other, the decline reason), `QuestionnaireError`. A preview stays folded under "Preview" until asked for.
- The drafts live inside it: key it by the question set (the card's id).
- Tokens: questions `sp-3` apart; header chip `cortex-100` with `cortex-700`, `r-xs`, `fs-meta` 500; question `n-800` 500; descriptions `text-meta` at `fs-meta`; inputs `n-0`, `n-200` border, `r-md`, `fs-xs`; radios and checkboxes take `action-primary`; previews `font-mono` `fs-meta` in `n-600`.
- Questions, options and previews are the agent's words: drawn as text, never markup. Presentation only (CV-64).
