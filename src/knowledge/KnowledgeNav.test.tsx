// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgeNav } from './KnowledgeNav';

/**
 * Threads first, named as their source names them (M33a.3).
 *
 * The nav's ORDER is the claim under test: `SECTIONS` and `ABOUT` were two
 * complete partitions of the same concepts, and the one that led was the one
 * nobody navigates by. Asserted on the rendered sequence rather than on the
 * headings alone, because a heading in the right place above rows in the wrong
 * one is the defect this phase exists to fix.
 */

afterEach(cleanup);

const about = (path: string, targets: string[]) =>
  makeEntry({
    path,
    filename: path.split('/').pop(),
    folder: path.slice(0, path.lastIndexOf('/')),
    type: 'Reference',
    relationships: { about: targets },
  });

const project = makeEntry({
  path: 'projects/phoenix/project.md',
  filename: 'project.md',
  folder: 'projects/phoenix',
  title: 'Phoenix warehouse rollout',
  type: 'Project',
});

describe('KnowledgeNav (M33a.3)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        project,
        about('knowledge/metrics/a.md', ['phoenix']),
        about('knowledge/metrics/b.md', ['phoenix']),
        // Nothing in the workspace is named `mpm-410` — an open thread.
        about('knowledge/risks/c.md', ['mpm-410']),
      ],
    });
  });

  it('leads with Threads and demotes Folders below the flat list', () => {
    const { container } = render(<KnowledgeNav nav={{ tab: 'all' }} />);
    const order = [...container.querySelectorAll('button, div')]
      .map((el) => (el.tagName === 'DIV' ? el.textContent : el.querySelector('span')?.textContent))
      .filter(
        (t): t is string =>
          t === 'Threads' ||
          t === 'Folders' ||
          t === 'All concepts' ||
          t === 'What it knows about itself',
      );
    expect(order).toEqual(['Threads', 'All concepts', 'Folders', 'What it knows about itself']);
    // `About` and `Sections` are gone, not renamed in one place and left in
    // another.
    expect(container.textContent).not.toContain('Sections');
  });

  it('lists the heaviest thread first and highlights it when nothing asked', () => {
    const { container } = render(<KnowledgeNav />);
    const threads = [...container.querySelectorAll('[data-tab="entity"]')];
    expect(threads.map((el) => el.querySelector('span')?.textContent)).toEqual([
      'Phoenix warehouse rollout',
      'mpm-410',
    ]);
    // The nav and the page resolve the same default, so the highlighted row
    // names the view on screen.
    expect(threads[0].getAttribute('aria-current')).toBe('page');
  });

  it('draws a dangling thread as open, never as a broken link (D7)', () => {
    const { container } = render(<KnowledgeNav nav={{ tab: 'all' }} />);
    expect(container.querySelector('[data-icon="link-2-off"]')).toBeNull();
    const open = container.querySelector('[data-icon="circle-dashed"]');
    expect(open).not.toBeNull();
    // Ordinary weight, not the --n-300 that said the row was damaged.
    expect(open?.getAttribute('style')).toContain('var(--n-500)');
  });
});
