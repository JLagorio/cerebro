import { describe, expect, it } from 'vitest';
import { STARTERS, pageStarters, starterSend } from '@/agent/elements/composerStarters';
import type { Concept } from '@/engine/okf';
import { makeEntry } from '@/engine/testHelpers';
import {
  ASK_BASE_LABEL,
  askBasePrompt,
  AUGMENT_LABEL,
  DISTILL_LABEL,
  RECHECK_LABEL,
  REVISE_LABEL,
} from '@/lib/prompts';

/**
 * The empty conversation's starters (M50.4, M91.12a): a page's own asks by
 * the names its surfaces give them, a concept's review ask, and what a press
 * sends — the label is what the row shows, the prompt what the agent reads.
 */

const page = makeEntry({ path: 'work/phoenix.md', title: 'Phoenix' });
const conceptPage = makeEntry({ path: 'knowledge/systems/drain.md', title: 'Drain time' });
const concept = (over: Partial<Concept> = {}): Concept =>
  ({ title: 'Drain time', stale: false, supersededBy: null, ...over }) as Concept;

describe('pageStarters', () => {
  it('offers the same three where nothing is open, each sending its own words', () => {
    expect(pageStarters(null, null)).toBe(STARTERS);
    expect(STARTERS.map((starter) => starter.label)).toEqual([
      'What is at risk right now?',
      'Help me clear the Inbox',
      'What do you know about this vault?',
    ]);
    expect(STARTERS.every((starter) => starter.prompt === undefined)).toBe(true);
  });

  it('asks a page what its own surfaces ask, by their names', () => {
    const starters = pageStarters(page, null);
    expect(starters.map((starter) => starter.label)).toEqual([
      ASK_BASE_LABEL,
      AUGMENT_LABEL,
      DISTILL_LABEL,
    ]);
    expect(starters[0].prompt).toBe(askBasePrompt(page.path, page.title));
    expect(starters[0].asked).toBe(`${ASK_BASE_LABEL} · Phoenix`);
  });

  it('asks a concept for its revision, a recheck when it is due, and nothing once replaced', () => {
    expect(pageStarters(conceptPage, concept()).map((s) => s.label)).toEqual([
      'What supports this concept?',
      REVISE_LABEL,
      'What do you know about this vault?',
    ]);
    expect(pageStarters(conceptPage, concept({ stale: true }))[1].label).toBe(RECHECK_LABEL);
    expect(
      pageStarters(conceptPage, concept({ supersededBy: 'knowledge/systems/new.md' })).map(
        (s) => s.label,
      ),
    ).toEqual(['What supports this concept?', 'What do you know about this vault?']);
  });
});

describe('starterSend', () => {
  it('sends the prompt behind a labelled ask, and leaves its bubble the act and the page', () => {
    const [ask] = pageStarters(page, null);
    const sent = starterSend(ask);
    expect(sent).toEqual({ text: `${ASK_BASE_LABEL} · Phoenix`, prompt: ask.prompt });
    expect(sent.prompt).not.toBe(ask.label);
  });

  it('sends a plain starter’s label as itself', () => {
    expect(starterSend(STARTERS[0])).toEqual({ text: 'What is at risk right now?' });
  });
});
