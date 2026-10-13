// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { RelatedKnowledge } from './RelatedKnowledge';

/**
 * The invocable half of the record↔knowledge join (M33a.5).
 *
 * The list itself is `relatedConcepts`, tested in engine/okf.test.ts. What is
 * asserted here is the AFFORDANCE: that a person can ask the base about the
 * record in front of them, that the question travels with the record attached,
 * and — the tone rule — that it is a button and not something that speaks
 * first.
 */

function entry(path: string, title: string, partial: Partial<Entry> = {}): Entry {
  return {
    path,
    filename: path.slice(path.lastIndexOf('/') + 1),
    folder: path.slice(0, Math.max(path.lastIndexOf('/'), 0)),
    project: null,
    title,
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-08-01T00:00:00Z',
    modifiedAt: '2026-08-01T00:00:00Z',
    parseError: null,
    ...partial,
  };
}

const RECORD = entry('records/reqs/rq-84b.md', 'RQ-84B Kestrel', { type: 'Requirement' });

/** The ask-the-base act, by the one name every surface gives it (M52.3). */
const ASK = 'What does Knowledge say about this?';

const CONCEPT = entry('knowledge/risks/thermal-margin.md', 'Thermal margin unproven', {
  type: 'Risk',
  properties: { description: 'The 60C case has never been run.' },
  relationships: { about: ['rq-84b'] },
});

beforeEach(() => {
  useVaultStore.setState({ entries: [RECORD, CONCEPT] });
  useUiStore.setState({ agentPendingPrompt: null, aiPanelOpen: false });
});

afterEach(cleanup);

describe('asking the base from the work', () => {
  it('hands the assistant a question that names knowledge_about and the record', () => {
    render(<RelatedKnowledge entry={RECORD} />);
    fireEvent.click(screen.getByRole('button', { name: ASK }));

    const pending = useUiStore.getState().agentPendingPrompt;
    expect(pending?.text).toContain('knowledge_about');
    expect(pending?.text).toContain('records/reqs/rq-84b.md');
    // The record travels as the SUBJECT too (M17.6) — a context chip, so the
    // agent reads this record rather than whatever surface was on screen.
    expect(pending?.subject).toBe('records/reqs/rq-84b.md');
    // And the bubble says what was pressed, about what (M52.3).
    expect(pending?.label).toBe(`${ASK} · RQ-84B Kestrel`);
  });

  it('offers the ask when the base holds nothing, which is when it is most useful', () => {
    useVaultStore.setState({ entries: [RECORD] });
    render(<RelatedKnowledge entry={RECORD} />);
    const section = screen.getByTestId('related-knowledge');
    expect(section.getAttribute('data-count')).toBe('0');
    expect(section.textContent).toContain('Nothing yet about this.');
    expect(screen.getByRole('button', { name: ASK })).toBeDefined();
  });

  it('never speaks first — nothing is asked until the button is pressed', () => {
    // M8's tone rule. A surface that opened the assistant on render would be
    // a notification wearing a section's clothes.
    render(<RelatedKnowledge entry={RECORD} />);
    expect(useUiStore.getState().agentPendingPrompt).toBe(null);
    expect(useUiStore.getState().aiPanelOpen).toBe(false);
  });

  it('keeps the draft question and the subject question apart', () => {
    // `askPrompt` reads the DRAFT in front of you; asking the base asks about
    // the SUBJECT. Two questions, two buttons — collapsing them would lose
    // the one that reaches concepts this list cannot.
    render(<RelatedKnowledge entry={RECORD} askPrompt="what am I missing" />);
    fireEvent.click(screen.getByRole('button', { name: "What's missing?" }));
    expect(useUiStore.getState().agentPendingPrompt?.text).toBe('what am I missing');
    expect(useUiStore.getState().agentPendingPrompt?.label).toBe(
      "What's missing? · RQ-84B Kestrel",
    );

    fireEvent.click(screen.getByRole('button', { name: ASK }));
    expect(useUiStore.getState().agentPendingPrompt?.text).toContain('knowledge_about');
  });
});

/**
 * M33a.6 — what the base no longer believes must not read as what it knows.
 *
 * `relatedConcepts` scores by anchor overlap, which measures relevance and
 * says nothing about whether a claim still stands. So a retired concept could
 * out-score a live one and lead the list, rendered identically.
 */
describe('a retired concept in the workspace', () => {
  const REPLACED = entry('knowledge/risks/thermal-old.md', 'Thermal margin (2026 estimate)', {
    type: 'Risk',
    properties: { description: 'Superseded by the measured run.' },
    relationships: { about: ['rq-84b'] },
  });
  const REPLACEMENT = entry('knowledge/risks/thermal-new.md', 'Thermal margin, measured', {
    type: 'Risk',
    relationships: { about: ['rq-84b'], supersedes: ['thermal-old'] },
  });

  beforeEach(() => {
    useVaultStore.setState({ entries: [RECORD, REPLACED, REPLACEMENT] });
  });

  it('says the word, not just the strikethrough', () => {
    render(<RelatedKnowledge entry={RECORD} />);
    const tag = screen.getByTestId('related-replaced');
    expect(tag.textContent).toBe('Replaced');
    // The row it belongs to is the retired one, not its replacement.
    const row = tag.closest('[data-testid="related-concept"]');
    expect(row?.getAttribute('data-path')).toBe('knowledge/risks/thermal-old.md');
  });

  it('sorts below everything still standing', () => {
    render(<RelatedKnowledge entry={RECORD} />);
    const paths = screen
      .getAllByTestId('related-concept')
      .map((el) => el.getAttribute('data-path'));
    expect(paths[paths.length - 1]).toBe('knowledge/risks/thermal-old.md');
  });

  it('drops the description of a claim nothing believes', () => {
    // A retired row says one thing — that it is no longer believed. Selling
    // it with its own summary is the confident-and-wrong shape.
    render(<RelatedKnowledge entry={RECORD} />);
    const row = screen
      .getAllByTestId('related-concept')
      .find((el) => el.getAttribute('data-path') === 'knowledge/risks/thermal-old.md');
    expect(row?.textContent).not.toContain('Superseded by the measured run.');
  });
});

/**
 * M52.3 — embedded in a page's Knowledge, the list is its rows and nothing
 * else, and a row names only the review states worth reading.
 */
describe('embedded in a page’s Knowledge', () => {
  it('draws rows only — no heading, no empty sentence, no asks', () => {
    render(<RelatedKnowledge entry={RECORD} variant="embedded" askPrompt="missing" />);
    const section = screen.getByTestId('related-knowledge');
    expect(section.querySelector('h3')).toBeNull();
    expect(screen.queryAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual([
      'related-concept',
    ]);
    cleanup();
    useVaultStore.setState({ entries: [RECORD] });
    render(<RelatedKnowledge entry={RECORD} variant="embedded" />);
    expect(screen.getByTestId('related-knowledge').textContent).toBe('');
  });

  it('says nothing of a review nobody gave', () => {
    // "Unreviewed" on every row was a tag on none (the Concepts list's rule).
    render(<RelatedKnowledge entry={RECORD} variant="embedded" />);
    expect(screen.queryByTestId('review-chip')).toBeNull();
  });
});
