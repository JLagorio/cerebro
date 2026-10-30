# Plan

The agent's todo list and how far it has got: "Plan · 2 of 5 done", opening onto its steps.

- Use it for a TodoWrite call, with the list its latest readable write left. A turn with no readable write draws no Plan (CV-05).
- Props: `todos` (`{ content, status, activeForm? }[]`, `status` `pending`, `in_progress` or `completed`), `isStreaming` (the run is live), `title` (default "Plan"), `description` (default the progress), `open`, `defaultOpen`, `onOpenChange`, `children` (a sentence above the steps).
- The line: `route` icon, "Plan", then "2 of 5 done" in `text-meta`. While live and unfinished it speaks "In progress" and carries the working light.
- Each step says its status in words before it: "To do", "In progress", "Done" (an unknown status is made readable, "In review"). Icons: `circle`, `circle-dot`, `circle-check`, `circle-dashed` for unknown.
- The step under way reads its `activeForm` ("Drafting a rehearsal plan") with the working light only while the run is live; a stopped run reads the imperative ("Draft a rehearsal plan").
- Steps not yet started are fainter (`n-500`); done and in-progress steps use the line ink `n-600`. Steps sit `sp-3` below any details sentence.
- It opens while the run works through it and closes when it stops, unless the reader chose. An empty list is a plain line, "No steps".
- Write steps in the imperative, sentence case. Presentation only (CV-64).
