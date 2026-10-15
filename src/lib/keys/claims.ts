import { keyOf, type KeyLike } from './combo';

/**
 * Which keystrokes an element keeps for itself (M65.1).
 *
 * The keymap listens in the capture phase on `window`, ahead of every editor
 * on the page, so a surface that types or edits says what it keeps with
 * `data-key-claim`, and the keymap leaves those keys alone:
 *
 *   - `typing` keeps every key without ⌘, ⌃ or ⌥ — typing, Enter, Backspace,
 *     Delete, the arrows — which is what an editor's own keymap reads;
 *   - `editor` keeps typing plus the modified handful that means something
 *     inside a rich-text editor: history (⌘Z/⌘⇧Z/⌘Y), the three marks
 *     (⌘B/⌘I/⌘U), select-all (⌘A) and ⌘Enter.
 *
 * An editable target — a text input, a textarea, a select, anything
 * contentEditable, a `[role=textbox]` — claims `editor` without saying so.
 * Everything else with a modifier belongs to the app, which is the point:
 * expressed as what the EDITOR takes rather than as a copy of the app's
 * shortcut list, a new app shortcut works inside an editor the day it is
 * added.
 */
export const EDITOR_MOD_KEYS = new Set(['z', 'y', 'b', 'i', 'u', 'a', 'enter']);

/**
 * The default host-editor claim (M29.53): whether a keystroke inside a
 * mermaid text field belongs to the editor around it. The source boxes stop
 * exactly these from reaching BlockNote and let the rest reach the app.
 */
export function claimedByHostEditor(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  if (!e.metaKey && !e.ctrlKey) return true;
  return EDITOR_MOD_KEYS.has(e.key.toLowerCase());
}

export type KeyClaim = 'typing' | 'editor';

const TEXT_INPUTS = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/**
 * Whether a keystroke aimed at `target` lands in something that edits text.
 * contentEditable is read from the nearest ancestor that sets it, because
 * jsdom implements no `isContentEditable`, and a `contenteditable="false"`
 * island inside an editor (a custom block's chrome) is not editable.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUTS.has(target.type || 'text');
  if (target.closest('[role="textbox"]') !== null) return true;
  const host = target.closest('[contenteditable]');
  return host !== null && host.getAttribute('contenteditable') !== 'false';
}

/** Every claim on `el` and its ancestors, plus `editor` for an editable target. */
export function claimsOf(el: EventTarget | null): Set<KeyClaim> {
  const claims = new Set<KeyClaim>();
  if (typeof Element === 'undefined' || !(el instanceof Element)) return claims;
  if (isEditableTarget(el)) claims.add('editor');
  for (let node: Element | null = el.closest('[data-key-claim]'); node !== null;) {
    for (const word of (node.getAttribute('data-key-claim') ?? '').split(/\s+/)) {
      if (word === 'typing' || word === 'editor') claims.add(word);
    }
    node = node.parentElement?.closest('[data-key-claim]') ?? null;
  }
  return claims;
}

/** Whether `claims` keep this keystroke from the keymap. */
export function claimsKey(claims: ReadonlySet<KeyClaim>, e: KeyLike): boolean {
  if (claims.size === 0) return false;
  const typing = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (typing) return true;
  if (!claims.has('editor')) return false;
  return (e.metaKey || e.ctrlKey) && EDITOR_MOD_KEYS.has(keyOf(e));
}
