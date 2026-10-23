import { RAIL_ENVIRONMENT_WORDS } from '@/agent/elements/railEnvironment';
import { EnvironmentCard } from '@/agent/rail/EnvironmentCard';
import type { RunReach } from '@/agent/types';
import { Rail } from '@/components/ai/Rail';
import { UNCOUNTED_WORDS } from '@/engine/git';
import { resetGitState } from '@/git/useGit';
import { resetMockGit } from '@/lib/mockGit';
import { setPanelAgent } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { LAB_VAULT, type LabSection } from '../presets';

/**
 * The rail's Environment card (M92.9) in its five states: the demo vault,
 * its history and sync as the app's one git state reads the mock repository
 * (`is_git_repo`, `git_remote_status`, seeded per preset), who answers in
 * its panel (`panel_agent`), and what the conversation's latest run said it
 * reaches (M92.8), drawn at the rail's width. The lab runs no turn, so each
 * preset's seed hands the stage the run's reach itself, and forgets the git
 * state the last preset read, so the stage reads its own.
 *
 * The card is never empty while a vault is open: its empty preset is its
 * git read's, a vault that keeps no history.
 *
 * Synthetic: an example remote, and the demo vault's release scout.
 */

/** A watched run: Cerebro's tools, with page writes that ask first (an
 *  ask-first record's), the shell and the web off, subagents on, and Claude
 *  Code's own edits off. */
const REACH: RunReach = {
  connectors: [],
  missing: [],
  missing_more: 0,
  inherits: false,
  permission_mode: 'acceptEdits',
  cerebro: true,
  families: {
    confirmable: ['ask'],
    shell: ['deny'],
    web: ['deny'],
    delegate: ['cli'],
    file_write: ['deny'],
  },
};

/** What the stage hands the card as the run's reach. Each preset's seed
 *  sets it before the stage mounts. */
let staged: RunReach | null = null;

/** A remote the mock repository tracks, two commits ahead of it. */
const REMOTE = { remoteUrl: 'https://github.com/acme/notes.git', ahead: 2 };

/** Stage the mock repository, the panel's binding and the run's reach. */
function seed({
  repo = REMOTE,
  reach = REACH,
  agent = null,
}: {
  repo?: Parameters<typeof resetMockGit>[0];
  reach?: RunReach | null;
  agent?: string | null;
} = {}) {
  return () => {
    staged = reach;
    resetMockGit(repo);
    resetGitState();
    if (agent !== null) void setPanelAgent(LAB_VAULT, agent);
  };
}

/** The rail, with the card over the open vault. */
function Stage() {
  const vault = useVaultStore((s) => s.vaultPath);
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <EnvironmentCard vault={vault} reach={staged} folded={false} />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-environment"]';
const HISTORY = '[data-testid="rail-environment-history"]';
const SYNC = '[data-testid="rail-environment-sync"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'rail-environment',
  title: 'Conversation environment',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'The demo vault on main, two commits to push; the panel answers as the release scout, and the run’s page writes ask first.',
      seed: seed({ agent: 'release-scout' }),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${HISTORY}[data-state="tracked"]`,
          `${SYNC}[data-state="ahead"]`,
          '[data-testid="rail-environment-answers"][data-state="agent"]',
          '[data-testid="rail-environment-pages"][data-state="asks"]',
        ],
        absent: [UNAVAILABLE],
        text: '2 to push',
      },
    },
    empty: {
      note: 'The vault keeps no history: History off, never a branch or a sync state.',
      seed: seed({ repo: { isRepo: false } }),
      expect: {
        present: [`${HISTORY}[data-state="off"]`],
        absent: [SYNC, UNAVAILABLE],
        text: RAIL_ENVIRONMENT_WORDS.historyOff,
      },
    },
    'not-recorded': {
      note: 'No run of the conversation has said what it reaches yet: the vault and its history still read.',
      seed: seed({ reach: null }),
      expect: {
        present: [
          `${CARD}[data-state="not-recorded"]`,
          '[data-testid="rail-environment-reach-not-recorded"]',
          `${HISTORY}[data-state="tracked"]`,
        ],
        absent: [UNAVAILABLE, '[data-testid="rail-environment-pages"]'],
        text: RAIL_ENVIRONMENT_WORDS.reachNotRecorded,
      },
    },
    partial: {
      note: 'git could not count the commits to push or pull: Sync unknown, never Up to date.',
      seed: seed({ repo: { ...REMOTE, countFails: true } }),
      expect: {
        present: [`${CARD}[data-state="partial"]`, `${SYNC}[data-state="unknown"]`],
        absent: [UNAVAILABLE],
        text: UNCOUNTED_WORDS.unread,
      },
    },
    unavailable: {
      note: 'The git read fails: unavailable, never a vault with no history.',
      seed: seed(),
      failNext: ['is_git_repo'],
      expect: {
        present: [`${CARD}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [HISTORY, SYNC],
        text: RAIL_ENVIRONMENT_WORDS.unavailable,
      },
    },
  },
};
