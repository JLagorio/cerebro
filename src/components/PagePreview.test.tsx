// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { readNote } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { PagePreview } from './PagePreview';

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  readNote: vi.fn(() => Promise.resolve('')),
}));

/** The hover card's face (M59.7), over the scan alone. */

const ROCKET = '\u{1F680}';

const MAP = makeEntry({
  path: 'strategy/systems-map.md',
  title: 'Systems map',
  snippet: "How the demo product's pieces talk to each other.",
  properties: { icon: ROCKET },
});
const BLANK = makeEntry({ path: 'notes/blank.md', title: 'Blank' });
const DECISION = makeEntry({
  path: 'records/decisions/dec-offline-window-72h.md',
  title: 'Offline window is 72 hours, not indefinite',
  type: 'Decision',
  properties: { status: 'accepted' },
  snippet: 'Crews asked for works offline without a bound.',
});
const DECISION_TYPE = makeEntry({
  path: 'types/decision.md',
  title: 'Decision',
  type: 'Type',
  properties: {
    statuses: [{ id: 'accepted', label: 'Accepted', group: 'done', color: '#2E9E5B' }],
    fields: { status: { kind: 'status' } },
  } as unknown as Entry['properties'],
});
const METRIC = makeEntry({
  path: 'knowledge/metrics/sync-error-rate.md',
  title: 'Sync error rate',
  type: 'Metric',
  snippet: 'Failed sync operations as a share of all sync attempts.',
});
const OLD = makeEntry({
  path: 'knowledge/metrics/old-rate.md',
  title: 'Old rate',
  type: 'Metric',
  snippet: 'The first try.',
});
const NEW = makeEntry({
  path: 'knowledge/metrics/new-rate.md',
  title: 'New rate',
  type: 'Metric',
  relationships: { supersedes: ['old-rate'] },
  snippet: 'The second try.',
});

function show(target: string, onOpen = vi.fn()) {
  render(<PagePreview target={target} onOpen={onOpen} />);
  return onOpen;
}

beforeEach(() => {
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [MAP, BLANK, DECISION, DECISION_TYPE, METRIC, OLD, NEW],
  });
});
afterEach(cleanup);

describe('PagePreview', () => {
  it('shows a page’s title, path and snippet', () => {
    show('systems-map');
    expect(screen.getByTestId('page-preview').getAttribute('data-state')).toBe('resolved');
    expect(screen.getByTestId('page-preview-title').textContent).toContain('Systems map');
    expect(screen.getByTestId('page-preview-path').textContent).toBe('strategy/systems-map.md');
    expect(screen.getByTestId('page-preview-snippet').textContent).toBe(
      "How the demo product's pieces talk to each other.",
    );
  });

  it('draws the page’s own icon', () => {
    show('systems-map');
    expect(screen.getByRole('img', { name: ROCKET }).getAttribute('data-icon-kind')).toBe('emoji');
  });

  it('shows a status chip when the type has a status field, and none for a doc', () => {
    show('dec-offline-window-72h');
    expect(screen.getByTestId('page-preview-status').textContent).toBe('Accepted');
    cleanup();
    show('systems-map');
    expect(screen.queryByTestId('page-preview-status')).toBeNull();
    expect(screen.queryByTestId('review-chip')).toBeNull();
  });

  it('shows a concept’s review state, and Replaced for a replaced one', () => {
    show('sync-error-rate');
    expect(screen.getByTestId('review-chip').getAttribute('data-review')).toBe('unreviewed');
    cleanup();
    show('old-rate');
    expect(screen.queryByTestId('review-chip')).toBeNull();
    expect(screen.getByTestId('page-preview').textContent).toContain('Replaced');
  });

  it('reads Title › Heading for a section link', () => {
    show('systems-map#Rollback');
    expect(screen.getByTestId('page-preview-title').textContent).toBe(
      `${ROCKET}Systems map › Rollback`,
    );
  });

  it('reads a heading of its own page for [[#Heading]]', () => {
    render(<PagePreview target="#Rollback" notePath={MAP.path} onOpen={vi.fn()} />);
    expect(screen.getByTestId('page-preview-title').textContent).toBe(
      `${ROCKET}Systems map › Rollback`,
    );
  });

  it('says so when the link dangles, naming the page half', () => {
    show('x');
    expect(screen.getByTestId('page-preview-missing').textContent).toBe('No page named "x"');
    cleanup();
    show('nothing#Steps');
    expect(screen.getByTestId('page-preview-missing').textContent).toBe('No page named "nothing"');
  });

  it('says there is no text when the snippet is empty', () => {
    show('blank');
    expect(screen.getByTestId('page-preview-empty').textContent).toBe('No text to preview.');
    expect(screen.queryByTestId('page-preview-snippet')).toBeNull();
  });

  it('opens the page from its title, and reads no file', () => {
    const onOpen = show('systems-map');
    fireEvent.click(screen.getByRole('button', { name: 'Open Systems map' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(readNote).not.toHaveBeenCalled();
  });
});
