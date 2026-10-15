import { useSyncExternalStore } from 'react';
import { Keycaps } from '@/components/ui/Keycaps';
import { chordOptions, pendingChord, subscribeChords } from '@/lib/keys/chords';
import { keymapVersion, subscribe } from '@/lib/keys/registry';

/** A reminder after the leader's silent window; it never takes focus. */
export function ChordHint() {
  const chord = useSyncExternalStore(subscribeChords, pendingChord, pendingChord);
  useSyncExternalStore(subscribe, keymapVersion, keymapVersion);
  if (chord === null || !chord.hintShown) return null;
  const options = chordOptions(chord);
  if (options.length === 0) return null;
  return (
    <div
      data-testid="chord-hint"
      role="status"
      data-key-neutral
      className="pointer-events-none fixed bottom-10 left-1/2 z-[100] w-[280px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-n-200 bg-surface-raised p-3 shadow-lg"
    >
      <div className="mb-2 text-xs font-semibold text-n-800">
        {chord.leader === 'g' ? 'Go to' : 'Create'}
      </div>
      <div className="space-y-1.5">
        {options.map(({ def, spec }) => (
          <div key={spec} className="flex items-center justify-between gap-4 text-sm text-n-700">
            <span>{def.label}</span>
            <Keycaps keys={spec} />
          </div>
        ))}
      </div>
    </div>
  );
}
