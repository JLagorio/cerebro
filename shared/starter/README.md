# Starter kit

The app offers these files once per empty vault, explicitly. They are installed
create-only in one batch: existing pages are never overwritten, and nothing is
written under knowledge/. Both agents are born paused and have explicit scopes.

The Type is installed first and Getting started last. The marker at
`.cerebro/starter.json` records an added or declined offer and stays outside the
scan. A failed marker save after a successful batch does not undo the pages;
the app tells the person. This is one set of bytes compiled by Rust and loaded
raw by the browser mock, so it needs no digest.

The kit also includes three editable recipes: Catch me up, Draft reply and
What I did. All only read the vault and none ships scheduled. Draft reply
requires an approved Gmail connector and leaves a draft there; it never sends.
Its Signature block is editable text on the skill's page, tracked by git.
Existing vaults can add only their missing copies from the Library; a page at
the shipped path or a Skill with its slug counts.
