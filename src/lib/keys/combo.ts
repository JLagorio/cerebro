/**
 * Key specs, as the command catalog writes them, and the keystrokes that
 * match them (M65.1). Pure: no DOM beyond reading a KeyboardEvent's fields.
 *
 * A spec is `+`-joined parts, modifiers first: `mod+shift+k`, `mod+\`,
 * `shift+g`, `enter`. A space makes a two-step chord, `g h`. `mod` is ⌘ on
 * macOS and Ctrl elsewhere; on macOS ⌃ is its own modifier, `ctrl`, so ⌃K,
 * ⌃E and ⌃F stay line editing in a text field.
 *
 * Escape is refused in every form: it belongs to `layers.ts`, where the
 * innermost surface takes it.
 */

export interface Combo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase: a letter, a digit, punctuation, or a named key (`enter`). */
  key: string;
}

/** One step, or a two-step chord. */
export type KeySteps = readonly [Combo] | readonly [Combo, Combo];

const MODIFIERS = new Set(['mod', 'ctrl', 'alt', 'shift']);

/** Keys a spec may name by word. */
const NAMED = new Set([
  'enter',
  'tab',
  'space',
  'backspace',
  'delete',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'home',
  'end',
  'pageup',
  'pagedown',
]);

const ESCAPES = new Set(['escape', 'esc']);

/** True on a Mac: `navigator.platform` first, then the user agent. */
function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  if (platform !== '') return /mac/i.test(platform);
  return /mac os x|macintosh/i.test(navigator.userAgent ?? '');
}

export const IS_MAC = detectMac();

function parseStep(step: string, spec: string): Combo {
  const parts = step.split('+');
  // `mod++` is not a spec anyone means; `mod+\` and `mod+[` are.
  if (parts.some((p) => p === '')) throw new Error(`key spec "${spec}" has an empty part`);
  const key = parts.at(-1)!.toLowerCase();
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  for (const m of mods) {
    if (!MODIFIERS.has(m)) throw new Error(`key spec "${spec}" names an unknown modifier "${m}"`);
  }
  if (new Set(mods).size !== mods.length) {
    throw new Error(`key spec "${spec}" repeats a modifier`);
  }
  if (ESCAPES.has(key) || mods.some((m) => ESCAPES.has(m))) {
    throw new Error(`key spec "${spec}" binds Escape, which belongs to layers.ts`);
  }
  if (MODIFIERS.has(key)) throw new Error(`key spec "${spec}" ends on a modifier`);
  if (key.length !== 1 && !NAMED.has(key)) {
    throw new Error(`key spec "${spec}" names an unknown key "${key}"`);
  }
  return {
    mod: mods.includes('mod'),
    ctrl: mods.includes('ctrl'),
    alt: mods.includes('alt'),
    shift: mods.includes('shift'),
    key,
  };
}

/** Parse a spec into its steps. Throws on Escape, an empty part, an unknown
 * modifier or key, or more than two steps. */
export function parseKeys(spec: string): KeySteps {
  const trimmed = spec.trim();
  if (trimmed === '') throw new Error('key spec is empty');
  const steps = trimmed.split(/\s+/);
  if (steps.length > 2) throw new Error(`key spec "${spec}" has more than two steps`);
  const parsed = steps.map((s) => parseStep(s, spec));
  return parsed.length === 1 ? [parsed[0]!] : [parsed[0]!, parsed[1]!];
}

/** One canonical string per combo, so two specs can be compared. */
export function comboId(c: Combo): string {
  return [c.mod && 'mod', c.ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', c.key]
    .filter(Boolean)
    .join('+');
}

/** One canonical string per spec. */
export function specId(spec: string): string {
  return parseKeys(spec).map(comboId).join(' ');
}

/** A letter command: no mod, ctrl or alt. These stand down while typing. */
export function isLetter(spec: string): boolean {
  return parseKeys(spec).every((c) => !c.mod && !c.ctrl && !c.alt);
}

/** The physical key a `KeyboardEvent.code` names, or null. */
function fromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const map: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Slash: '/',
    Period: '.',
    Comma: ',',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    Space: 'space',
    Enter: 'enter',
    NumpadEnter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
  };
  return map[code] ?? null;
}

/** US-layout shifted punctuation, for a synthetic event that carries no code. */
const UNSHIFTED: Record<string, string> = {
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
  _: '-',
  '+': '=',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The key a keystroke names, in a spec's terms.
 *
 * One ASCII character from `e.key`, lowercased. Under Shift or Option a digit
 * or punctuation mark reads the physical key instead, so `{` matches
 * `mod+shift+[` and `ƒ` matches `mod+alt+f`. Anything else — a non-Latin
 * layout, an Option-composed letter — falls back to `e.code`, and an event
 * with no code (a synthetic one) keeps `e.key`.
 */
export function keyOf(e: KeyLike): string {
  const key = e.key ?? '';
  const code = e.code ?? '';
  if (key === ' ') return 'space';
  if (key.length === 1 && key.charCodeAt(0) < 128) {
    const lower = key.toLowerCase();
    if ((e.shiftKey || e.altKey) && !/[a-z]/.test(lower)) {
      const physical = code === '' ? null : fromCode(code);
      if (physical !== null) return physical;
      if (e.shiftKey && UNSHIFTED[key] !== undefined) return UNSHIFTED[key];
    }
    return lower;
  }
  const lower = key.toLowerCase();
  if (NAMED.has(lower) || ESCAPES.has(lower)) return lower;
  const physical = code === '' ? null : fromCode(code);
  return physical ?? lower;
}

/** Whether a keystroke is exactly this combo: modifiers match exactly. */
export function matchesCombo(c: Combo, e: KeyLike, mac: boolean = IS_MAC): boolean {
  if (keyOf(e) !== c.key) return false;
  if (e.altKey !== c.alt || e.shiftKey !== c.shift) return false;
  if (mac) return e.metaKey === c.mod && e.ctrlKey === c.ctrl;
  // Elsewhere mod is Ctrl or ⌘ — jsdom's metaKey tests and Linux CI's
  // ControlOrMeta both land here — and a spec naming `ctrl` wants Ctrl.
  const held = e.metaKey || e.ctrlKey;
  if (c.ctrl) return e.ctrlKey && (c.mod || !e.metaKey);
  return held === c.mod;
}

/** Whether a keystroke completes a one-step spec. Chords never match here. */
export function matchesSpec(spec: string, e: KeyLike, mac: boolean = IS_MAC): boolean {
  const steps = parseKeys(spec);
  return steps.length === 1 && matchesCombo(steps[0], e, mac);
}

const GLYPH_KEYS: Record<string, string> = {
  enter: '↵',
  backspace: '⌫',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  tab: '⇥',
  space: 'Space',
  delete: '⌦',
};

const WORD_KEYS: Record<string, string> = {
  enter: 'Enter',
  backspace: 'Backspace',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  tab: 'Tab',
  space: 'Space',
  delete: 'Delete',
};

function keyLabel(key: string, mac: boolean): string {
  const named = (mac ? GLYPH_KEYS : WORD_KEYS)[key];
  if (named !== undefined) return named;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The caps a spec draws: one group per step. On macOS the modifiers are
 * glyphs in Apple's order (⌃ ⌥ ⇧ ⌘); elsewhere they are words, Ctrl first.
 */
export function keycapParts(spec: string, mac: boolean = IS_MAC): string[][] {
  return parseKeys(spec).map((c) => {
    const parts: string[] = [];
    if (mac) {
      if (c.ctrl) parts.push('⌃');
      if (c.alt) parts.push('⌥');
      if (c.shift) parts.push('⇧');
      if (c.mod) parts.push('⌘');
    } else {
      if (c.mod || c.ctrl) parts.push('Ctrl');
      if (c.shift) parts.push('Shift');
      if (c.alt) parts.push('Alt');
    }
    parts.push(keyLabel(c.key, mac));
    return parts;
  });
}
