# SectionBoundary

Keeps a render fault inside one section: the section draws as unavailable with Retry, and the rest of the window stays mounted.

- Wrap each pane, panel, peek, editor and rail card in one, so drafts, decisions and streams elsewhere survive a fault. The app's `Contained` adds the flush of open pages; Dialog ("This dialog") and HoverCard ("This card") carry one already.
- Props: `label` (what stopped drawing, as the fallback names it: "This page", "This panel"), `children`, `resetKey` (a new value starts the section over), `onCatch(error, info)` (told once per fault; the owner decides what to save), `onBack` (adds a ghost Back button), `compact`, `fallbackClassName` (wraps the fallback to fill a frame), `whileFailed` (mounted only while the section is down, for what must keep answering).
- The fallback is a `StateMessage` with `state="unavailable"`: "<label> stopped drawing", "Retry draws it again. It changes nothing on disk.", a small secondary Retry and the optional Back.
- A second fault after Retry stays down: "<label> stopped drawing again", "It stays unavailable until you open it again. Nothing on disk changed.", with Back only, until `resetKey` changes.
- `compact` draws the fallback without the sunken well, for cards and panels.
- Retry only draws the children again (keyed afresh). Nothing here reloads the window, clears storage or writes a file.
- Presentation only: it reads no store and writes nothing; the owner injects what a fault should save through `onCatch`.
- Unavailable is never empty (CV-05): a section that failed must not fall back to its empty state.
