import { describe, expect, it } from 'vitest';
import { PRESETS } from './SelectionToolbar';

/**
 * M18 — the AI controls you can see.
 *
 * The toolbar itself is BlockNote's, so whether it APPEARS is BlockNote's
 * question and is asked where BlockNote actually runs (e2e/agent.spec.ts).
 * What is worth pinning here is the contract the buttons carry: a preset is a
 * pre-written instruction, and the button's behaviour has to live in that
 * string rather than in a code path named after the label.
 */
describe('PRESETS', () => {
  it('carries a real instruction, not the label on the button', () => {
    // If a preset's behaviour lived anywhere but this string, nobody could
    // predict what a button does or change it without touching the editor.
    for (const preset of PRESETS) {
      expect(preset.instruction.length).toBeGreaterThan(20);
      expect(preset.instruction).not.toBe(preset.label);
    }
  });

  it('starts with the two everyone actually wants', () => {
    // Only the first two ride on the bar; the rest are one click further. That
    // order is the design, so it is asserted rather than left to a slice.
    expect(PRESETS.slice(0, 2).map((p) => p.label)).toEqual(['Improve writing', 'Make it shorter']);
  });

  it('tells the model what to preserve, not only what to change', () => {
    // The failure mode of a one-word instruction is a rewrite that also
    // changes the voice, drops a caveat, or reformats the markdown — and each
    // of those lands as a hunk the user has to reject one at a time.
    const improve = PRESETS.find((p) => p.label === 'Improve writing');
    expect(improve?.instruction).toMatch(/keep|preserve/i);
    const grammar = PRESETS.find((p) => p.label === 'Fix spelling & grammar');
    expect(grammar?.instruction).toMatch(/nothing else/i);
  });

  it('has a unique label per preset, since the label is the React key', () => {
    expect(new Set(PRESETS.map((p) => p.label)).size).toBe(PRESETS.length);
  });
});
