// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listConcepts, listSubjects } from '@/engine/okf';
import { makeEntry } from '@/engine/testHelpers';
import type { Entry } from '@/engine/types';
import { ThreadView } from './ThreadView';

/**
 * The thread reads as one thing (M33a.4).
 *
 * What is under test is the ORDER of findings and the honesty of the counts —
 * not the derivation, which okf.test.ts owns. A section that disappears when
 * it is empty and a concept sorted into a position its absent timestamp did
 * not earn are the two failures this surface is here to prevent.
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
  return { ...view, section, onOpenConcept };
}

describe('ThreadView', () => {
  it('leads with what is contested, and keeps it out of what is known', () => {
    const { section } = mount([
      project,
      knows('offline-window', { title: 'The offline window' }),
      knows('offline-guarantee', {
        title: 'The offline guarantee',
        relations: { supersedes: ['offline-window'] },
      }),
    ]);
    const contested = section('contested');
    expect(contested.textContent).toContain('The offline window');
    expect(contested.textContent).toContain('replaced by The offline guarantee');
    // A retired claim listed under "what's known" would be the surface saying
    // the base believes something it has explicitly stopped believing.
    expect(section('known').textContent).not.toContain('The offline window');
    expect(section('known').textContent).toContain('The offline guarantee');
  });

  it('still renders the contested section on a settled thread, with a plain line', () => {
    // Omitting the heading turns a finding into silence: "nothing is in
    // dispute" is something the reader came here to learn.
    const { section } = mount([project, knows('one', { title: 'One' })]);
    const contested = section('contested');
    expect(contested.textContent).toContain("What's contested");
    expect(contested.textContent).toContain('Nothing in this thread is in dispute');
  });

  it('reports an undated concept as not recorded rather than sorting it last', () => {
    const { section } = mount([
      project,
      knows('old', {
        title: 'Old',
        properties: { generated: { by: 'claude-code', at: '2026-05-01T00:00:00Z' } },
      }),
      knows('undated', { title: 'Undated' }),
    ]);
    const changed = section('changed');
    expect(changed.textContent).toContain('1 concept is not placed above');
    expect(changed.textContent).toContain('when it was written is not recorded');
    // The dated one keeps its position, and the undated one is not given one.
    const rows = changed.querySelectorAll('[data-testid="thread-concept"]');
    expect(rows[0].getAttribute('data-path')).toBe('knowledge/old.md');
  });

  it('names what is stale and how long it has been due', () => {
    const { section } = mount([
      project,
      knows('due', { title: 'Due a recheck', properties: { stale_after: '2026-07-26' } }),
    ]);
    expect(section('stale').textContent).toContain('Due a recheck since 2026-07-26');
    expect(section('stale').textContent).toContain('2d ago');
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
    const { section } = mount([project, knows('one', { title: 'One' })]);
    expect(section('known').textContent).toContain('No description recorded');
  });

  it('opens a concept from any row it appears in', () => {
    const onOpenConcept = vi.fn();
    const { section } = mount([project, knows('one', { title: 'One' })], onOpenConcept);
    const row = section('known').querySelector('[data-testid="thread-concept"]');
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(onOpenConcept).toHaveBeenCalledWith('knowledge/one.md');
  });
});
