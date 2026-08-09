// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { Rail } from './Rail';

function capture(path: string, daysAgo: number): Entry {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    path,
    filename: path.split('/').pop() ?? '',
    folder: 'inbox',
    project: null,
    title: 'Untitled',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: at,
    modifiedAt: at,
    parseError: null,
  };
}

describe('Rail', () => {
  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useUiStore.setState({ inboxEnabled: true, inboxPeriod: 'all', aiPanelOpen: false });
    useVaultStore.setState({ entries: [] });
  });
  afterEach(cleanup);

  it('navigates to the Docs surface', () => {
    render(<Rail />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'docs' });
  });

  it('keeps Docs active on a doc page, Home active on collections', () => {
    useNavStore.setState({ selection: { kind: 'doc', path: 'inbox/welcome.md' } });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Docs' }).className).toContain('cortex');
    expect(screen.getByRole('button', { name: 'Home' }).className).not.toContain('cortex');
    cleanup();

    // M29.21: a standalone .mmd is a document surface — Docs owns it too.
    useNavStore.setState({ selection: { kind: 'diagram', path: 'diagrams/pipeline.mmd' } });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Docs' }).className).toContain('cortex');
    expect(screen.getByRole('button', { name: 'Home' }).className).not.toContain('cortex');
    cleanup();

    // M12.5: projects retired — a container selection is a Collection.
    useNavStore.setState({ selection: { kind: 'collection', folder: 'projects/x' } });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Home' }).className).toContain('cortex');
    expect(screen.getByRole('button', { name: 'Docs' }).className).not.toContain('cortex');
  });

  // M15: Home's active state used to be computed by negating every other slot,
  // so any kind nobody remembered to negate lit it up.
  it('leaves Home dark on the surfaces another slot owns', () => {
    for (const selection of [
      { kind: 'settings' } as const,
      { kind: 'changes' } as const,
      { kind: 'knowledge' } as const,
      { kind: 'diagram', path: 'diagrams/pipeline.mmd' } as const,
    ]) {
      useNavStore.setState({ selection });
      render(<Rail />);
      expect(screen.getByRole('button', { name: 'Home' }).className).not.toContain('cortex');
      cleanup();
    }
  });

  it('marks the current destination with aria-current and the assistant with aria-pressed', () => {
    useNavStore.setState({ selection: { kind: 'docs' } });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Docs' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    // A toggle is not a destination: it reports pressed, never current.
    const assistant = screen.getByRole('button', { name: 'Assistant' });
    expect(assistant.getAttribute('aria-pressed')).toBe('false');
    expect(assistant.getAttribute('aria-current')).toBeNull();
    fireEvent.click(assistant);
    expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  // M15: the badge counted every period while the page opened on a persisted
  // one, so a rail reading "Inbox 2" could land on an empty screen.
  it('counts the period the Inbox will actually open on', () => {
    useVaultStore.setState({
      entries: [capture('inbox/a.md', 1), capture('inbox/b.md', 40)],
    });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Inbox (2)' })).toBeTruthy();
    cleanup();

    useUiStore.setState({ inboxPeriod: 'week' });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Inbox (1)' })).toBeTruthy();
  });
});
