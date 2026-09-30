// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgeStrip } from './KnowledgeStrip';

afterEach(cleanup);

const project = makeEntry({ path: 'projects/phoenix.md', title: 'Phoenix', type: 'Project' });
const aboutIt = (n: number): Entry =>
  makeEntry({
    path: `knowledge/playbooks/p${n}.md`,
    title: `Playbook ${n}`,
    type: 'Playbook',
    relationships: { about: ['phoenix'] },
  });

describe('KnowledgeStrip (M50.2)', () => {
  it('says nothing about a page Knowledge holds nothing about', () => {
    useVaultStore.setState({ entries: [project] });
    render(<KnowledgeStrip entry={project} />);
    expect(screen.queryByTestId('knowledge-strip')).toBeNull();
  });

  it('names what Knowledge holds about the page, each opening as its page', () => {
    useVaultStore.setState({ entries: [project, aboutIt(1), aboutIt(2)] });
    render(<KnowledgeStrip entry={project} />);
    const concepts = screen.getAllByTestId('knowledge-strip-concept');
    expect(concepts.map((c) => c.textContent)).toEqual(['Playbook 1', 'Playbook 2']);
    // Unverified concepts wait on a person, and the strip says how many.
    expect(screen.getByTestId('knowledge-strip-waiting').textContent).toContain('2 to review');
    fireEvent.click(concepts[0]);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'knowledge/playbooks/p1.md',
    });
  });

  it('counts what was learned FROM the page too, each concept once (M52.3)', () => {
    const learned = makeEntry({
      path: 'knowledge/systems/drain.md',
      title: 'Drain time',
      properties: { sources: [{ id: 's', resource: '/projects/phoenix.md' }] },
    });
    // Anchored AND cited: one concept, not two.
    const both = makeEntry({
      path: 'knowledge/playbooks/both.md',
      title: 'Both ways',
      properties: { sources: [{ id: 's', resource: 'projects/phoenix.md' }] },
      relationships: { about: ['phoenix'] },
    });
    useVaultStore.setState({ entries: [project, learned, both] });
    render(<KnowledgeStrip entry={project} />);
    expect(screen.getAllByTestId('knowledge-strip-concept').map((c) => c.textContent)).toEqual([
      'Both ways',
      'Drain time',
    ]);
  });

  // M52.3 — a count you could not act on. It opens the first waiting concept
  // in the queue's own order, where the review bar's pager takes over.
  it('opens the first concept waiting on a person, in the order the queue works them', () => {
    const due = makeEntry({
      path: 'knowledge/metrics/due.md',
      title: 'Due',
      type: 'Metric',
      properties: {
        stale_after: '2020-01-01',
        verified: [{ by: 'human:josef', at: '2019-06-01T00:00:00Z' }],
      } as unknown as Entry['properties'],
      relationships: { about: ['phoenix'] },
    });
    useVaultStore.setState({ entries: [project, aboutIt(1), due] });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    render(<KnowledgeStrip entry={project} />);
    const waiting = screen.getByTestId('knowledge-strip-waiting');
    expect(waiting.tagName).toBe('BUTTON');
    expect(waiting.textContent).toContain('2 to review');
    fireEvent.click(waiting);
    // Past its recheck date ranks ahead of new — the queue's order, not the strip's.
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'knowledge/metrics/due.md',
    });
  });

  it('names three and sends the rest to the side panel', () => {
    useVaultStore.setState({ entries: [project, ...[1, 2, 3, 4, 5].map(aboutIt)] });
    useUiStore.setState({ docPanelOpen: false, docPanelTab: 'outline' });
    render(<KnowledgeStrip entry={project} />);
    expect(screen.getAllByTestId('knowledge-strip-concept')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(useUiStore.getState().docPanelOpen).toBe(true);
    expect(useUiStore.getState().docPanelTab).toBe('knowledge');
  });
});
