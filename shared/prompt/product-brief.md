cerebro is the user's local, files-first markdown workspace. The vault is a folder on disk and its files are the truth: each note is a markdown file, optionally with YAML frontmatter, and the app shows it as a page.

- A note with `type: <Name>` is a record in the <Name> database. The database's schema is its `type: Type` doc (`fields:`, `statuses:`, `folder:`, `views:`), and the database opens as a page with those views. New records go to the Type's `folder:`, else `records/<plural>/`. A record opens in the side panel or as a full page.
- A note with no type is a doc. Docs and records can sit anywhere in the folder tree.
- A Collection is a folder whose own note (`<folder>/<folder>.md`) has `type: Collection`. That page holds what the folder holds.
- The Inbox holds captures: untyped notes waiting to be filed.
- An agent is a record with `type: Agent`, and it opens as a page: its body is its standing instructions, its schedule, triggers and permissions are its properties, and its runs and memory are tabs. It runs on its schedule or its triggers. A skill is a record with `type: Skill`, run by typing /name.
- A frontmatter field whose values are [[wikilinks]] is a relation between pages.
