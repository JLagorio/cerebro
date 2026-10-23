import { memo, useMemo } from 'react';
import {
  RAIL_ENVIRONMENT_WORDS,
  answersAs,
  railEnvironment,
  type RailEnvironmentLine,
} from '@/agent/elements/railEnvironment';
import type { RunReach } from '@/agent/types';
import { RailSection } from '@/components/ai/Rail';
import { Icon } from '@/components/ui/Icon';
import { StateMessage } from '@/components/ui/StateMessage';
import { useGit } from '@/git/useGit';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import './environment-card.css';

/**
 * The rail's Environment card (M92.9, §2): the vault, its history and sync
 * as the shell says them, who answers in the vault's panel, and what the
 * conversation's latest run reaches (`railEnvironment`). Read-only (Q6):
 * the ceilings, the binding and the remote stay in Settings.
 *
 * Its git facts are the app's one git state (`useGit`), never a read of its
 * own: shown, it keeps that state fresh as every other surface does; folded
 * away with the rail, it watches nothing, so it starts no probe and no poll
 * (`watch: false`). A git read that failed is unavailable, never a vault
 * with no history; while git has not answered, the card makes no claim.
 */

export interface EnvironmentCardProps {
  /** The open vault. */
  vault: string | null;
  /** What the conversation's latest run said it reaches
   *  (`conversations.threadReach`); null when none has. */
  reach: RunReach | null;
  /** Folded away with the rail (ConversationRail), hidden and inert: the
   *  card reads and watches nothing until the rail unfolds. */
  folded: boolean;
}

/** A folded card keeps what it drew; an unfolding one draws the latest. */
function stillWhileFolded(before: EnvironmentCardProps, after: EnvironmentCardProps): boolean {
  if (before.folded && after.folded) return true;
  return (
    before.vault === after.vault && before.reach === after.reach && before.folded === after.folded
  );
}

export const EnvironmentCard = memo(function EnvironmentCard({
  vault,
  reach,
  folded,
}: EnvironmentCardProps) {
  const { ready, isRepo, readError, branch, remote, sync, modified, conflicts } = useGit({
    watch: !folded,
  });
  const handle = useUiStore((s) => (vault === null ? null : s.panelAgents[vault]));
  const unreadable = useUiStore((s) => vault !== null && s.panelAgentsUnreadable[vault] === true);
  const entries = useVaultStore((s) => s.entries);
  const answers = useMemo(
    () => answersAs(handle, unreadable, entries),
    [handle, unreadable, entries],
  );
  const view = useMemo(
    () =>
      railEnvironment({
        vault,
        git: { ready, isRepo, readError, branch, remote, sync, modified, conflicts },
        answers,
        reach,
      }),
    [vault, ready, isRepo, readError, branch, remote, sync, modified, conflicts, answers, reach],
  );
  if (view.state === null) return null;
  return (
    <RailSection
      data-testid="rail-environment"
      title={RAIL_ENVIRONMENT_WORDS.title}
      icon="monitor"
      state={view.state}
      count={view.count}
      none={RAIL_ENVIRONMENT_WORDS.none}
    >
      {view.state === 'unavailable' && (
        <StateMessage compact state="unavailable" title={RAIL_ENVIRONMENT_WORDS.unavailable}>
          {view.reason}
        </StateMessage>
      )}
      {view.notes.map((note) => (
        <StateMessage key={note} compact state="partial" title={note} />
      ))}
      <dl className="cb-rail-environment">
        {view.lines.map((line) => (
          <Line key={line.key} line={line} />
        ))}
      </dl>
      {view.reachNotRecorded && (
        <StateMessage
          compact
          state="not-recorded"
          title={RAIL_ENVIRONMENT_WORDS.reachNotRecorded}
          testId="rail-environment-reach-not-recorded"
        >
          {RAIL_ENVIRONMENT_WORDS.reachNotRecordedDetail}
        </StateMessage>
      )}
    </RailSection>
  );
}, stillWhileFolded);

/** One term and its value; the sync line leads with the SyncBadge's icon. */
function Line({ line }: { line: RailEnvironmentLine }) {
  return (
    <div
      data-testid={`rail-environment-${line.key}`}
      data-state={line.state}
      className="cb-rail-environment-line"
    >
      <dt>{line.term}</dt>
      <dd title={line.detail ?? line.value}>
        {line.icon !== undefined && (
          <Icon name={line.icon.name} size={12} color={line.icon.color} />
        )}
        <span className="cb-rail-environment-value">{line.value}</span>
      </dd>
    </div>
  );
}
