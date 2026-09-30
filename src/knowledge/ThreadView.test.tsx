// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listConcepts, listSubjects } from '@/engine/okf';
import { makeEntry } from '@/engine/testHelpers';
import type { Entry } from '@/engine/types';
import { ThreadView } from './ThreadView';

/**
 * The thread reads as one thing (M33a.4), in one list (M51).
 *
 * What is under test is that each concept appears ONCE, on its most
 * consequential line, in the order a reader should meet them, and the honesty
 * of the counts — not the derivation, which okf.test.ts owns. The findings
 * the empty sections used to state ("nothing contested") are still said, in
 * the summary line.
 */

afterEach(cleanup);

const TODAY = '2026-07-28';

const project = makeEntry({
  path: 'projects/phoenix/project.md',
  filename: 'project.md',
  folder: 'projects/phoenix',
  title: 'Phoenix warehouse rollout',
  type: 'Project',
});

const knows = (
  name: string,
  patch: {
    title?: string;
    type?: string;
    properties?: Record<string, unknown>;
    relations?: Record<string, string[]>;
  } = {},
): Entry =>
  makeEntry({
    path: `knowledge/${name}.md`,
    filename: `${name}.md`,
    folder: 'knowledge',
    title: patch.title ?? name,
    type: patch.type ?? 'Reference',
    relationships: { about: ['phoenix'], ...(patch.relations ?? {}) },
    properties: patch.properties,
  });

function mount(entries: Entry[], onOpenConcept = vi.fn()) {
  const concepts = listConcepts(entries, TODAY);
  const [subject] = listSubjects(concepts, entries);
  const view = render(
    <ThreadView
      subject={subject}
      concepts={concepts}
      entries={entries}
      today={TODAY}
      onOpenConcept={onOpenConcept}
    />,
  );
  const section = (id: string) => {
    const found = view.container.querySelector(`[data-section="thread-${id}"]`);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  };
  const rows = () =>
    [...view.container.querySelectorAll('[data-testid="thread-concept"]')] as HTMLElement[];
  const summary = () => view.getByTestId('thread-summary').textContent ?? '';
  return { ...view, section, rows, summary, onOpenConcept };
}

describe('ThreadView', () => {
  it('lists each concept once, what is contested first', () => {
    const { rows } = mount([
      project,
      knows('offline-window', {
        title: 'The offline window',
        properties: { generated: { by: 'claude-code', at: '2026-05-01T00:00:00Z' } },
      }),
      knows('offline-guarantee', {
        title: 'The offline guarantee',
        relations: { supersedes: ['offline-window'] },
        properties: { generated: { by: 'claude-code', at: '2026-06-01T00:00:00Z' } },
      }),
    ]);
    // M51 — it was printed under "contested" AND under "what changed".
    expect(rows().map((r) => r.dataset.path)).toEqual([
      'knowledge/offline-window.md',
      'knowledge/offline-guarantee.md',
    ]);
    expect(rows()[0].textContent).toContain('Replaced by The offline guarantee');
  });

  it('still says nothing is contested on a settled thread — in one line, not a heading', () => {
    const { summary, container } = mount([project, knows('one', { title: 'One' })]);
    expect(summary()).toContain('1 concept · nothing contested');
    expect(container.querySelector('[data-section="thread-contested"]')).toBeNull();
  });

  it('reports an undated concept as not recorded rather than sorting it last', () => {
    const { rows } = mount([
      project,
      knows('undated', { title: 'Undated' }),
      knows('old', {
        title: 'Old',
        properties: { generated: { by: 'claude-code', at: '2026-05-01T00:00:00Z' } },
      }),
    ]);
    // The dated one keeps its position, and the undated one is not given one.
    expect(rows().map((r) => r.dataset.path)).toEqual(['knowledge/old.md', 'knowledge/undated.md']);
    expect(rows()[1].textContent).toContain('When it was written is not recorded');
  });

  it('names what is stale and how long it has been due, before the rest', () => {
    const { rows, summary } = mount([
      project,
      knows('fresh', {
        title: 'Fresh',
        properties: { generated: { by: 'claude-code', at: '2026-07-27T00:00:00Z' } },
      }),
      knows('due', { title: 'Due a recheck', properties: { stale_after: '2026-07-26' } }),
    ]);
    expect(rows()[0].textContent).toContain('Due a recheck · 2 days overdue');
    expect(summary()).toContain('1 due a recheck');
  });

  it('counts what cites each source, and counts what cites nothing', () => {
    const { section } = mount([
      project,
      knows('one', {
        title: 'One',
        properties: {
          sources: [{ id: 'dec', resource: '/records/dec.md', title: 'The decision' }],
        },
      }),
      knows('two', {
        title: 'Two',
        properties: { sources: [{ id: 'dec', resource: 'records/dec.md' }] },
      }),
      knows('three', { title: 'Three' }),
    ]);
    const sources = section('sources');
    expect(sources.querySelectorAll('[data-testid="thread-source"]')).toHaveLength(1);
    expect(sources.textContent).toContain('The decision');
    expect(sources.textContent).toContain('cited by 2 concepts');
    // Absorbed into the list above, a concept resting on nothing would look
    // exactly like one resting on the decision.
    expect(sources.textContent).toContain('1 concept in this thread cites no source at all');
  });

  it('says so when a concept carries no description', () => {
    // M33a.0 made `description` a requirement; a bundle written before it has
    // none, and every row saying nothing at all is how that stayed invisible.
    const { rows } = mount([project, knows('one', { title: 'One' })]);
    expect(rows()[0].textContent).toContain('No description recorded');
  });

  it('opens a concept from its row', () => {
    const onOpenConcept = vi.fn();
    const { rows } = mount([project, knows('one', { title: 'One' })], onOpenConcept);
    fireEvent.click(rows()[0]);
    expect(onOpenConcept).toHaveBeenCalledWith('knowledge/one.md');
  });
});
