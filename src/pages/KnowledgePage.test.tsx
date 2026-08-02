// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgePage } from './KnowledgePage';

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return { ...actual, readNote: vi.fn(async () => '# Body\n') };
});

afterEach(cleanup);

function concept(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    folder: partial.path.slice(0, partial.path.lastIndexOf('/')),
    project: null,
    title: 'Untitled',
    type: 'Concept',
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    ...partial,
  };
}

const OLD = 'knowledge/claims/offline-window.md';
const NEW = 'knowledge/claims/offline-window-v2.md';

describe('KnowledgePage and a replaced concept (M15)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: OLD, title: 'The offline window' }),
        concept({
          path: NEW,
          title: 'The offline window, revised',
          properties: { supersedes: '/claims/offline-window.md' },
        }),
      ],
    });
  });

  it('labels the retired row and warns in its reading pane', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' }, path: OLD }} />);
    // A strikethrough alone was the only signal, with no legend anywhere.
    expect(screen.getAllByTestId('replaced-tag')).toHaveLength(1);
    const banner = screen.getByTestId('superseded-banner');
    expect(banner.textContent).toContain('No longer believed');
    expect(banner.textContent).toContain('The offline window, revised');
  });

  it('says nothing of the sort on the concept that replaced it', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' }, path: NEW }} />);
    expect(screen.queryByTestId('superseded-banner')).toBeNull();
  });
});

describe('KnowledgePage verification (M15)', () => {
  const today = todayIso();

  beforeEach(() => {
    useUiStore.setState({ actorId: 'josef' });
  });

  it('refuses a second identical stamp from the same actor on the same day', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          // Nested YAML passes through `properties` raw — the type says
          // scalars, the parser does not (see Entry.properties).
          properties: {
            verified: [{ by: 'human:josef', at: `${today}T09:00:00Z` }],
          } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    const button = screen.getByRole('button', { name: /Verified by you today/ });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('offers Verify, and a Recheck beside the stale chip that Verify cannot clear', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: { stale_after: '2020-01-01' },
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.getByRole('button', { name: /^Verify$/ }).hasAttribute('disabled')).toBe(false);
    // `verify_concept` may write `verified` and nothing else, so staleness is
    // the agent's to clear — the remedy has to be reachable from the chip.
    expect(screen.getByTestId('recheck-concept')).toBeTruthy();
  });
});
