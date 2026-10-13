// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgeNav } from './KnowledgeNav';

/**
 * The bundle's folders, then the queue that waits for a person (M51.1).
 *
 * Asserted on the rendered sequence: the rows ARE the claim. Fifteen subject
 * rows were a second index of the vault inside this section (M33a.3–M50.5);
 * a subject's knowledge is on its own page now.
 */

afterEach(cleanup);

const about = (path: string, targets: string[], properties: Record<string, unknown> = {}) =>
  makeEntry({
    path,
    filename: path.split('/').pop(),
    folder: path.slice(0, path.lastIndexOf('/')),
    type: 'Reference',
    relationships: { about: targets },
    properties,
  });

describe('KnowledgeNav (M51.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        makeEntry({ path: 'projects/phoenix.md', title: 'Phoenix', type: 'Project' }),
        about('knowledge/metrics/a.md', ['phoenix']),
        about('knowledge/metrics/b.md', ['phoenix'], {
          verified: [{ by: 'human:josef', at: '2026-07-01' }],
        }),
        about('knowledge/risks/c.md', ['mpm-410']),
      ],
    });
  });

  it('lists the folders, then Review — no subjects, no second nav', () => {
    const { container } = render(<KnowledgeNav nav={{ tab: 'all' }} />);
    const rows = [...container.querySelectorAll('[data-testid="knowledge-nav-row"]')];
    expect(rows.map((el) => [el.getAttribute('data-tab'), el.textContent])).toEqual([
      ['section', 'Metrics2'],
      ['section', 'Risks1'],
      // Two of the three wait for a person; the count is the queue's.
      ['review', 'Review2'],
    ]);
    for (const gone of ['Phoenix', 'mpm-410', 'All concepts', 'Needs review']) {
      expect(container.textContent).not.toContain(gone);
    }
  });

  it('opens a folder as a filter of Concepts, and lights it', () => {
    const { container, rerender } = render(<KnowledgeNav nav={{ tab: 'all' }} />);
    fireEvent.click(container.querySelector('[data-tab="section"]')!);
    const selection = useNavStore.getState().selection;
    expect(selection).toEqual({ kind: 'knowledge', nav: { tab: 'section', folder: 'metrics' } });
    rerender(<KnowledgeNav nav={{ tab: 'section', folder: 'metrics' }} />);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Metrics2');
  });

  it('lights nothing while another surface owns the canvas', () => {
    const { container } = render(<KnowledgeNav current={false} />);
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
  });
});
