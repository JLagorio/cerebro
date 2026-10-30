# Sources

What a reply drew on: one line, "Used 3 sources", that opens onto a line per source in the order the turn met them.

- Use it under a reply, for the pull requests a session opened, or for the Knowledge a turn carries (single `Source` rows in your own trace).
- Provide `sources: SourceRef[]` from `engine/ai/sources.ts`: `{ kind: 'url', url, title?, via }` or `{ kind: 'vault', path, title?, via }`, where `via` is `search`, `fetch`, `read` or `text`. An empty list draws nothing.
- `title` and `icon` replace the line's words and its `book-open` ("Opened 2 pull requests", `git-pull-request`). It starts closed; `defaultOpen` or `open` opens it.
- A web page is a link (`globe`) named by its title, then its host ("Cutover en.wikipedia.org"), with an `arrow-up-right`; it opens in a new tab and says so to a screen reader. An untitled one is named by its host.
- A vault page (`file-text`) is a button that opens it in the app through `onOpenPath`, named by its title or else its path. Never an href (CV-16).
- A URL that is not http(s), or a path outside the vault, stays a line of text.
- `Source` takes `description` for quiet words after the name that are never cut short ("· replaced", "· unreviewed").
- Tokens: lines in `n-600` at `fs-ui`/`lh-ui`, `n-900` on hover; hosts and descriptions in `text-meta`; the open rule in `border-subtle`; focus is `ring` on `r-lg`.
- Presentation only (CV-64): the caller collects and dedupes the sources.
