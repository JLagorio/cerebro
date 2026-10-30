# ModelSelector

Which model runs a turn and how hard it thinks: one trigger and one panel holding the Model and Effort radio groups.

- Use it in the composer's toolbar (`appearance="icon"`) or as a labelled control (`label`, the default). The pick belongs to the conversation; the caller persists it.
- Props: `label` (the pick in words: "Claude Code default", "Opus · High"), `models` and `efforts` (`ModelSelectorChoice`: `value`, `label`, `testId`), `model` and `effort` (the checked value, or `null` when none of the choices is it), `onModelChange`, `onEffortChange`, `other` (`defaultValue`, `validate(name)` returning a refusal or null, `onUse(name)`), `open` and `onOpenChange` (the caller's, so a failure card's "Choose another model" can open it), `note` ("Last answered by claude-opus-5-5"), `disabled` while a turn streams.
- Choices come from `shared/policy/run-options.v1.json` through `composerModel`: `''` is Claude Code's default, then Fable, Opus, Sonnet, Haiku, and Low to Max. No list of models is typed here (CV-04).
- Parts: the trigger (a `cpu` glyph; its name is "Model and effort: <label>"), the panel (a `Popover`: Escape, click-away, focus held while open and handed back), `ModelSelectorGroup` (a heading and a `radiogroup`), `ModelSelectorItem` (a label over a native radio, so the whole row picks, with a check), `ModelSelectorInput` (Other: a full model name and Use; a refused name says why under the field).
- The panel stays open through both picks (a deliberate deviation from shadcn's two menus); Enter in Other uses it, and nothing in it is a form submit.
- Trigger: 32px, `r-md`, `fs-xs` in `n-500`; `n-50` with `n-800` on hover or while open; focus `ring`.
- Panel: 240px, `n-0`, `n-200` border, `r-lg`, `shadow-lg`; headings `fs-2xs` uppercase `n-400` with `track-caps`; rows `fs-xs` in `n-700`, the checked one `surface-selected` with `cortex-700`; groups divided by `n-100`.
- Other: `font-mono` at `fs-2xs`, `n-200` border, `danger-500` when invalid; the refusal in `danger-600`.
- Presentation only (CV-64): `RunOptionsPicker` wires it to the conversation; Rust checks the choice again before a run starts.
