// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DocPage } from './DocPage';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { makeEntry } from '@/test/factories';
import * as ipc from '@/lib/ipc';
import type { Entry } from '@/engine/types';
import type { SelectedRecordState, SelectedRecordVersion } from '@/lib/generated/workspace';

// BL-25: a selected record's own state shows where its page renders. Rust
// decided the state and wrote its words; the page names it, shows no body for
// it and offers no writer, and never falls back to the legacy page.
const VAULT = '/selected-record-states';
const version: SelectedRecordVersion = {
  kind: 'sqlite_metadata',
  workspaceId: '51d68354-28be-4e1d-b4fd-776c7d49f94e',
  recordId: 'e3592157-40ca-442c-9905-bac1885238b1',
  metadataRevision: '3',
  metadataHash: 'a'.repeat(64),
  bodyHash: 'b'.repeat(64),
};

function show(entry: Entry) {
  useVaultStore.setState({
    vaultPath: VAULT,
    entriesVault: VAULT,
    status: 'ready',
    entries: [entry],
  });
  render(<DocPage selection={{ kind: 'doc', path: entry.path }} />);
}

function state(kind: SelectedRecordState['kind'], visiblePath?: string): SelectedRecordState {
  return {
    kind,
    message: `Rust's words for ${kind}.`,
    ...(visiblePath === undefined ? {} : { visiblePath }),
  };
}

describe('a selected record with its own state', () => {
  beforeEach(() => {
    useUiStore.setState({ docPanelOpen: false, toasts: [] });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useVaultStore.setState({ vaultPath: null, entriesVault: null, entries: [], status: 'idle' });
  });

  it.each([
    ['body_missing', 'Page file missing'],
    ['body_unavailable', 'Page file unavailable'],
    ['conflict', 'Name conflict'],
  ] as const)('shows %s by name with no body and no page options', (kind, title) => {
    const read = vi.spyOn(ipc, 'readNote');
    show(
      makeEntry({
        path: 'notes/b.md',
        authority: version,
        hash: null,
        parseError: `Rust's words for ${kind}.`,
        selectedState: state(kind, kind === 'conflict' ? 'notes/B.md' : undefined),
      }),
    );
    const shown = screen.getByTestId('selected-record-state');
    expect(shown.getAttribute('data-record-state')).toBe(kind);
    expect(shown.textContent).toContain(title);
    expect(shown.textContent).toContain(`Rust's words for ${kind}.`);
    if (kind === 'conflict') expect(shown.textContent).toContain('Visible as notes/B.md.');
    expect(screen.queryByTestId('selected-body')).toBeNull();
    expect(screen.queryByText('Loading page body…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Page options' })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['plain_page_candidate', 'notes/pulled.md', 'Not yet a page in this workspace'],
    ['unsupported_carrier', 'flows/release.mmd', 'No reader in this workspace yet'],
  ] as const)(
    'routes %s, which has no canonical identity, away from the legacy page',
    (kind, path, title) => {
      const read = vi.spyOn(ipc, 'readNote');
      const legacySave = vi.spyOn(ipc, 'saveNoteBody');
      show(
        makeEntry({
          path,
          hash: null,
          parseError: `Rust's words for ${kind}.`,
          selectedState: state(kind),
        }),
      );
      expect(screen.getByTestId('selected-record-state').textContent).toContain(title);
      expect(screen.queryByTestId('markdown-editor')).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(legacySave).not.toHaveBeenCalled();
    },
  );

  it('keeps an ordinary page changed outside Cerebro in its own body view, with a notice', () => {
    // The body read stays pending: this asserts the view, not the read.
    const read = vi.spyOn(ipc, 'readNote').mockReturnValue(new Promise<string>(() => {}));
    show(
      makeEntry({
        path: 'notes/b.md',
        authority: version,
        hash: 'c'.repeat(64),
        bodyObservation: { coherence: 'external_change', observedBodyHash: 'c'.repeat(64) },
        selectedState: state('needs_reconciliation'),
      }),
    );
    const notice = screen.getByTestId('selected-record-state');
    expect(notice.textContent).toContain('Changed outside Cerebro');
    expect(notice.querySelector('[data-state="partial"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Page options' })).toBeTruthy();
    expect(read).toHaveBeenCalledWith(VAULT, 'notes/b.md');
  });

  it('withholds a protected page changed outside Cerebro', () => {
    show(
      makeEntry({
        path: 'agents/helper.md',
        authority: version,
        hash: 'c'.repeat(64),
        parseError: "Rust's words for needs_reconciliation.",
        selectedState: state('needs_reconciliation'),
      }),
    );
    const notice = screen.getByTestId('selected-record-state');
    expect(notice.querySelector('[data-state="unavailable"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Page options' })).toBeNull();
    expect(screen.queryByText('Loading page body…')).toBeNull();
  });
});
