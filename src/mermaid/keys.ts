/**
 * Which keystrokes a mermaid text field has to swallow, and which it must let
 * past (M29.53).
 *
 * Both source boxes — the document block's and the canvas code panel's — stop
 * a keystroke from reaching BlockNote's hotkeys (and the canvas's
 * Delete-deletes-node) while someone is typing mermaid, and only the keys the
 * surrounding EDITOR claims: anything unmodified, plus history, the three
 * marks, select-all and ⌘Enter. Everything else with a modifier belongs to
 * the app.
 *
 * The keymap listens in the capture phase (`src/lib/keys/root.ts`), so these
 * stops no longer stand between a key and an app shortcut, and this rule is
 * its default host-editor claim, kept in `src/lib/keys/claims.ts`. It is
 * re-exported here for the source boxes that stop keys by it.
 */
export { claimedByHostEditor, EDITOR_MOD_KEYS } from '@/lib/keys/claims';
