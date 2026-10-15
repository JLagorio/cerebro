# Starter kit

The app offers these files once per empty vault, explicitly. They are installed
create-only in one batch: existing pages are never overwritten, and nothing is
written under knowledge/. Both agents are born paused and have explicit scopes.

The Type is installed first and Getting started last. The marker at
`.cerebro/starter.json` records an added or declined offer and stays outside the
scan. A failed marker save after a successful batch does not undo the pages;
the app tells the person. This is one set of bytes compiled by Rust and loaded
raw by the browser mock, so it needs no digest.

The kit also includes two editable, read-only recipes: Catch me up and What I
did. Neither ships scheduled. Existing vaults can add only their missing copies
from the Library; a page at the shipped path or a Skill with its slug counts.
