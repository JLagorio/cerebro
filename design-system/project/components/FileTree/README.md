# FileTree

The files a turn changed, as a folder tree: each saying how it changed in words and its lines.

- Use it for a run's changeset under its reply, and anywhere a set of changed vault paths is listed.
- Provide `tree: FileTreeNode[]` from `engine/ai/fileTree.ts` `buildFileTree`: folders first, in name order, a folder holding only one folder collapsed into one row ("projects/phoenix-warehouse-rollout"). An empty tree draws nothing.
- A file row: its change icon (`file-plus`, `file-pen`, `file-minus`, `file-symlink`), its name, then "added", "modified", "deleted" or "renamed" and "+12 −3". A rename adds "from <old path>" under it.
- A folder row counts its files and sums only the lines git counted: "3 files · +31 −4 · 1 binary". Folders start open; `defaultExpanded` (a set of paths) opens only those.
- Pass `onOpenPath` so a file is a button that opens it in the app; a deleted file, or a path outside the vault, is a line of text. Never an href (CV-16). `selectedPath` marks the file shown now in `text-primary` at `w-medium`.
- `actions(file)` draws buttons beside a row (show changes, View diff), never inside it; `detail(file)` hangs lines under it ("also edited by you", a patch). `tabIndex` puts every row in the Tab order where WebKit would not.
- Absent is never zero (CV-05): a file git counted no lines for reads "binary", or "not recorded" with `missingCounts="not_recorded"`.
- Tokens: rows on the trace line, `n-600` at `fs-ui`/`lh-ui`, counts in `text-meta` with tabular numerals; the open rule in `border-subtle`; rename notes in `text-meta` at `fs-meta`.
- It is a list of buttons, each a tab stop, not an ARIA tree.
