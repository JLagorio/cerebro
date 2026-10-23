// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LAB_NOW } from '@/lab/clock';
import { applyPreset, LAB_STATES, labSections, unmetExpectations } from '@/lab/presets';
import { resetFaults } from '@/lib/mockFaults';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore, type VaultState } from '@/stores/vaultStore';
import { TranscriptSpeakers } from './TranscriptSpeakers';

/**
 * The Speakers block (M64.7): each lab preset, opening a matched page, and the
 * one write it makes, Add N, only when the type has exactly one person field.
 */

const disk = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const section = labSections().find((s) => s.id === 'transcript-speakers');

beforeAll(() => {
  vi.setSystemTime(LAB_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  resetFaults();
});

/** Stage a capture at `path` and open the demo vault over it. */
async function staged(path: string, frontmatter: string[]): Promise<void> {
  resetMockFs();
  disk().set(path, ['---', ...frontmatter, '---', '', '# Standup', ''].join('\n'));
  await useVaultStore.getState().openVault('/demo-vault');
}

describe('TranscriptSpeakers', () => {
  it.each(LAB_STATES)('renders its %s preset', async (state) => {
    if (section === undefined) throw new Error('no transcript-speakers lab section');
    await applyPreset(section, state);
    const { container } = render(<div>{section.render()}</div>);
    await waitFor(() =>
      expect(unmetExpectations(container, section.states[state].expect)).toEqual([]),
    );
  });

  it('opens a matched page through the app’s router', async () => {
    await staged('inbox/standup.md', ['ingest_format: vtt', 'speakers: [Marcus Webb]']);
    useNavStore.setState({ selection: { kind: 'inbox' } });
    render(<TranscriptSpeakers path="inbox/standup.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'Marcus Webb' }));
    await waitFor(() => {
      const nav = useNavStore.getState().selection;
      const detail = useUiStore.getState().detailPath;
      expect([detail, 'path' in nav ? nav.path : null]).toContain('people/marcus-webb.md');
    });
  });

  it('Add N writes the union into the one person field the type declares', async () => {
    await staged('inbox/standup.md', [
      'type: Meeting',
      'ingest_format: vtt',
      'speakers: [Marcus Webb, Priya Nair, Jo Nobody]',
      "attendees: ['[[marcus-webb]]', '[[dana-fox]]']",
    ]);
    const patchFrontmatter = vi.fn<VaultState['patchFrontmatter']>().mockResolvedValue(true);
    useVaultStore.setState({ patchFrontmatter });
    render(<TranscriptSpeakers path="inbox/standup.md" />);
    const add = screen.getByRole('button', { name: 'Add 1 to Attendees' });
    // An act drawn as the inspector's row, not an outlined button.
    expect(add.classList.contains('cb-inspector-action')).toBe(true);
    fireEvent.click(add);
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/standup.md', {
      attendees: ['[[marcus-webb]]', '[[dana-fox]]', '[[priya-nair]]'],
    });
  });

  // The inspector's one voice: a sentence-case subhead, no overline and no
  // rule of its own; a match names its page, a miss says why, quietly.
  it('heads its rows with the inspector subhead and names each match', async () => {
    await staged('inbox/standup.md', ['ingest_format: vtt', 'speakers: [Marcus Webb, Jo Nobody]']);
    render(<TranscriptSpeakers path="inbox/standup.md" />);
    const block = screen.getByTestId('transcript-speakers');
    expect(block.querySelector('.cb-inspector-subhead')?.textContent).toBe('Speakers');
    expect(block.querySelector('.uppercase, .border-t')).toBeNull();
    const [matched, missed] = screen.getAllByTestId('speaker-row');
    expect(matched.querySelector('button')?.textContent).toBe('Marcus Webb');
    expect(missed.querySelector('button')).toBeNull();
    expect(missed.textContent).toBe('Jo Nobodyno page');
  });

  it('offers no Add while the capture is untyped, or its type has several person fields', async () => {
    await staged('inbox/standup.md', ['ingest_format: vtt', 'speakers: [Marcus Webb]']);
    render(<TranscriptSpeakers path="inbox/standup.md" />);
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
    cleanup();

    resetMockFs();
    disk().set(
      'types/review.md',
      '---\ntype: Type\nfields:\n  reviewers: { kind: person }\n  approvers: { kind: person }\n---\n\n# Review\n',
    );
    disk().set(
      'inbox/standup.md',
      '---\ntype: Review\ningest_format: vtt\nspeakers: [Marcus Webb]\n---\n\n# Standup\n',
    );
    await useVaultStore.getState().openVault('/demo-vault');
    render(<TranscriptSpeakers path="inbox/standup.md" />);
    expect(screen.getByTestId('transcript-speakers')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
  });

  it('renders nothing for a capture that is not a transcript', async () => {
    await staged('inbox/thought.md', ['ingest_format: markdown', 'speakers: [Marcus Webb]']);
    const { container } = render(<TranscriptSpeakers path="inbox/thought.md" />);
    expect(container.innerHTML).toBe('');
  });
});
