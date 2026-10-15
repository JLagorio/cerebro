import { catalog, type CommandDef } from '@/app/commands';
import { comboId, keyOf, matchesCombo, matchesSpec, parseKeys, type KeyLike } from './combo';
import { findBinding, inDesktop, type Chain, type Hit } from './registry';

/** The second key gets a short silent window before the reminder appears. */
export const HINT_MS = 200;
export const RESET_MS = 2000;

export interface PendingChord {
  leader: string;
  chain: Chain;
  hintShown: boolean;
}

export interface ChordOption {
  def: CommandDef;
  spec: string;
}

type Accept = (def: CommandDef, spec: string) => boolean;
const available: Accept = (def) => !def.desktopOnly || inDesktop();
let pending: PendingChord | null = null;
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let resetTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function pendingChord(): PendingChord | null {
  return pending;
}

export function subscribeChords(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cancelChord(): void {
  clearTimeout(hintTimer);
  clearTimeout(resetTimer);
  hintTimer = undefined;
  resetTimer = undefined;
  if (pending === null) return;
  pending = null;
  changed();
}

/** Only live bindings in the armed chain appear, including palette-hidden rows. */
export function chordOptions(chord: PendingChord, accept: Accept = available): ChordOption[] {
  const out: ChordOption[] = [];
  const seen = new Set<string>();
  for (const def of catalog()) {
    for (const spec of def.keys) {
      const steps = parseKeys(spec);
      if (steps.length !== 2 || comboId(steps[0]) !== chord.leader || seen.has(spec)) continue;
      const hit = findBinding(
        chord.chain,
        (candidate) => candidate.keys.includes(spec) && accept(candidate, spec),
      );
      if (hit === null) continue;
      seen.add(spec);
      out.push({ def: hit.def, spec });
    }
  }
  return out;
}

/** Arm only a plain letter with a live chord and no single-key binding. */
export function armChord(e: KeyLike, chain: Chain, accept: Accept = available): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !/^[a-z]$/.test(keyOf(e))) return false;
  const candidate: PendingChord = { leader: keyOf(e), chain: [...chain], hintShown: false };
  if (chordOptions(candidate, accept).length === 0) return false;
  if (findBinding(chain, (def) => def.keys.some((spec) => matchesSpec(spec, e)))) return false;
  cancelChord();
  pending = candidate;
  hintTimer = setTimeout(() => {
    if (pending !== candidate) return;
    pending = { ...candidate, hintShown: true };
    changed();
  }, HINT_MS);
  resetTimer = setTimeout(cancelChord, RESET_MS);
  changed();
  return true;
}

/** A miss passes during the silent window; after the hint it belongs to the
 * chord. Escape always passes to the innermost layer. Binding availability
 * is checked again, so a command removed while the hint was up never runs. */
export function finishChord(
  e: KeyLike,
  accept: Accept = available,
): { hit: Hit | null; swallow: boolean } | null {
  const chord = pending;
  if (chord === null) return null;
  cancelChord();
  if (keyOf(e) === 'escape') return { hit: null, swallow: false };
  const hit = findBinding(chord.chain, (def) =>
    def.keys.some((spec) => {
      const steps = parseKeys(spec);
      return (
        steps.length === 2 &&
        comboId(steps[0]) === chord.leader &&
        matchesCombo(steps[1], e) &&
        accept(def, spec)
      );
    }),
  );
  return { hit, swallow: hit !== null || chord.hintShown };
}
