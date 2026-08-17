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
    fireEvent.click(screen.getByRole('button', { name: 'Ask the base' }));

    const pending = useUiStore.getState().agentPendingPrompt;
    expect(pending?.text).toContain('knowledge_about');
    expect(pending?.text).toContain('records/reqs/rq-84b.md');
    // The record travels as the SUBJECT too (M17.6) — a context chip, so the
    // agent reads this record rather than whatever surface was on screen.
    expect(pending?.subject).toBe('records/reqs/rq-84b.md');
  });

  it('offers the ask when the base holds nothing, which is when it is most useful', () => {
    useVaultStore.setState({ entries: [RECORD] });
    render(<RelatedKnowledge entry={RECORD} />);
    const section = screen.getByTestId('related-knowledge');
    expect(section.getAttribute('data-count')).toBe('0');
    expect(section.textContent).toContain('Nothing yet about this.');
    expect(screen.getByRole('button', { name: 'Ask the base' })).toBeDefined();
  });

  it('never speaks first — nothing is asked until the button is pressed', () => {
    // M8's tone rule. A surface that opened the assistant on render would be
    // a notification wearing a section's clothes.
    render(<RelatedKnowledge entry={RECORD} />);
    expect(useUiStore.getState().agentPendingPrompt).toBe(null);
    expect(useUiStore.getState().aiPanelOpen).toBe(false);
  });

  it('keeps the draft question and the subject question apart', () => {
    // `askPrompt` reads the DRAFT in front of you; `Ask the base` asks about
    // the SUBJECT. Two questions, two buttons — collapsing them would lose
    // the one that reaches concepts this list cannot.
    render(<RelatedKnowledge entry={RECORD} askPrompt="what am I missing" askLabel="Missing?" />);
    fireEvent.click(screen.getByRole('button', { name: 'Missing?' }));
    expect(useUiStore.getState().agentPendingPrompt?.text).toBe('what am I missing');

    fireEvent.click(screen.getByRole('button', { name: 'Ask the base' }));
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
