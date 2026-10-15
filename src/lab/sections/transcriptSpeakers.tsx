import { useEffect } from 'react';
import { TranscriptSpeakers } from '@/detail/TranscriptSpeakers';
import { armedFaults } from '@/lib/mockFaults';
import { useVaultStore } from '@/stores/vaultStore';
import type { LabSection } from '../presets';

/**
 * A transcript capture's Speakers block (M64.7) in its five states, over one
 * staged capture in the demo vault's Inbox. The demo's people pages are who
 * a speaker can match.
 */

const CAPTURE = 'inbox/lab-standup.md';

/** The mock's disk, as `window.__cerebroMockFs` exposes it. */
function disk(): Map<string, string> {
  return (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
}

/** Stage the capture, with `speakers` as YAML, or no key at all when undefined. */
function stage(speakers?: string): void {
  disk().set(
    CAPTURE,
    [
      '---',
      'title: Lab standup',
      'ingested_at: 2026-07-28T09:14:00Z',
      'ingest_format: vtt',
      ...(speakers === undefined ? [] : [`speakers: ${speakers}`]),
      '---',
      '',
      '# Lab standup',
      '',
      '**Marcus Webb:** The rollback is written down, not rehearsed.',
      '',
    ].join('\n'),
  );
}

/**
 * The block, and a re-read of the vault when a scan failure is armed. The
 * block reads only the store, so the lab's one way to show a failed read is
 * the read itself: a reopen, the way a person's Reopen would, that fails.
 */
function Stage() {
  useEffect(() => {
    const vault = useVaultStore.getState().vaultPath;
    if (vault !== null && armedFaults().scan_vault !== undefined) {
      void useVaultStore.getState().openVault(vault);
    }
  }, []);
  return <TranscriptSpeakers path={CAPTURE} />;
}

const BLOCK = '[data-testid="transcript-speakers"]';
const ROW = '[data-testid="speaker-row"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'transcript-speakers',
  title: 'Transcript speakers',
  surface: 'Inbox › Organize',
  render: () => <Stage />,
  states: {
    ready: {
      note: "Three speakers, each one of the demo's people.",
      seed: () => stage('[Marcus Webb, Priya Nair, Tom Keller]'),
      expect: {
        present: [`${BLOCK}[data-state="ready"]`, `${ROW}[data-match="matched"]`],
        absent: [`${ROW}[data-match="none"]`, `${ROW}[data-match="ambiguous"]`, UNAVAILABLE],
      },
    },
    empty: {
      note: 'A transcript that names nobody: `speakers: []`.',
      seed: () => stage('[]'),
      expect: {
        present: [`${BLOCK}[data-state="empty"]`],
        absent: [ROW, UNAVAILABLE],
        text: 'The file names no speakers',
      },
    },
    'not-recorded': {
      note: 'A capture from before speakers were recorded: no `speakers` key.',
      seed: () => stage(),
      expect: {
        present: [`${BLOCK}[data-state="not-recorded"]`],
        absent: [ROW, UNAVAILABLE],
        text: 'Speakers not recorded',
      },
    },
    partial: {
      note: 'One matched, one with no page, and one two pages share.',
      seed: () => {
        stage('[Marcus Webb, Jo Nobody, Tom Keller]');
        disk().set(
          'people/tom-keller-contractor.md',
          '---\ntype: Person\nrole: Contractor\n---\n\n# Tom Keller\n',
        );
      },
      expect: {
        present: [
          `${BLOCK}[data-state="partial"]`,
          `${ROW}[data-match="matched"]`,
          `${ROW}[data-match="none"]`,
          `${ROW}[data-match="ambiguous"]`,
        ],
        absent: [UNAVAILABLE],
        text: '2 pages match',
      },
    },
    unavailable: {
      note: 'The vault scan fails, so nothing can be matched.',
      seed: () => stage('[Marcus Webb]'),
      failNext: ['scan_vault'],
      expect: {
        present: [`${BLOCK}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [ROW],
      },
    },
  },
};
