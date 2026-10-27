import { PageHeader } from '@/components/PageHeader';
import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { CONSTRUCT_ACTORS } from '@/engine/authors';
import type { Selection } from '@/engine/types';
import { AgentRoster } from '@/status/AgentRoster';
import { AgentRunHistory } from '@/status/AgentRunHistory';
import { FleetSection } from '@/status/FleetSection';
import { FollowupList } from '@/status/FollowupList';
import { WakesSection } from '@/status/WakesSection';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import './workspacePages.css';

export type AgentsSelection = Extract<Selection, { kind: 'agents' }>;

/** The path of the record that answers to `actor`, or null for a construct
 * or a dangling name. */
function useAgentPath(actor: string | undefined): string | null {
  const entries = useVaultStore((s) => s.entries);
  return useMemo(() => {
    if (actor === undefined) return null;
    return entries.filter(isAgentEntry).find((e) => agentRef(e).actor === actor)?.path ?? null;
  }, [entries, actor]);
}

/**
 * An actor with no record (M41; M55.12): a construct's page, with its runs,
 * or the absent state for a name nothing declares. An actor WITH a record
 * never reaches here — AgentsPage forwards it to that record's page.
 */
function AgentDetail({ actor }: { actor: string }) {
  const navigate = useNavStore((s) => s.navigate);

  // The three internal constructs (`agent::meter::CONSTRUCT_ACTORS`) are
  // permanently record-less — `meter.rs` records why — so their page says
  // so, in plain words, instead of offering an editor that could not exist.
  const construct = CONSTRUCT_ACTORS.find((c) => c.actor === actor);
  if (construct !== undefined) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 py-5" data-testid="agent-construct">
          <p className="m-0 text-sm leading-[19px] text-n-600" title={actor}>
            <strong>{construct.label}</strong> is work Cerebro runs itself, not an agent you manage.
            It has no record and nothing to edit — what it may do is fixed in the app, not set by a
            page in your vault. Its runs are below.
          </p>
          <div className="mt-4">
            <AgentRunHistory actor={actor} />
          </div>
        </div>
      </div>
    );
  }
  // Absent, said as absent: a dangling deep link is not an empty agent.
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      <EmptyState
        icon="bot"
        title="No agent answers to this name"
        description={`Nothing in the vault declares the actor "${actor}". It may have been renamed or deleted.`}
        action={
          <Button variant="secondary" onClick={() => navigate({ kind: 'agents' })}>
            All agents
          </Button>
        }
      />
    </div>
  );
}

/**
 * The agents' front door (M41).
 *
 * The roster, what is waiting to wake it (M63.1b), and the fleet's run feed:
 * who is on duty, what will run, and what ran. Each
 * agent is its own page (M55.12) — its instructions, its grants, its runs and
 * its memory — and the roster opens it on its Runs tab. Internal constructs,
 * which have no page, keep one here.
 */
export function AgentsPage({ selection }: { selection: AgentsSelection }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  // An actor with a record is that record's PAGE (M55.12). Run detail,
  // proposal cards, the review bar and Knowledge all link here by actor and
  // reach the page through this forward, which replaces the slot so Back
  // never lands on a selection that only forwards.
  const forward = useAgentPath(selection.actor);
  useEffect(() => {
    if (forward !== null) navigate({ kind: 'doc', path: forward }, { replace: true });
  }, [forward, navigate]);

  if (forward !== null) return null;

  if (selection.actor !== undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="agents-page">
        <div className="flex h-11 flex-none items-center gap-2 border-b border-n-200 px-4">
          <button
            type="button"
            aria-label="Back to all agents"
            data-testid="agents-back"
            onClick={() => navigate({ kind: 'agents' })}
            className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-800"
          >
            <Icon name="arrow-left" size={15} />
          </button>
          <Icon name="bot" size={16} color="var(--n-600)" />
          <h1 className="m-0 text-lg font-semibold leading-6 tracking-[-0.005em]">Agents</h1>
        </div>
        <AgentDetail actor={selection.actor} />
      </div>
    );
  }

  return (
    <div
      className="cb-agents-page cb-composition flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="agents-page"
    >
      <PageHeader
        composition="collection"
        title="Agents"
        description="Your agents, what they're working on, and what happens next."
        actions={
          <Button
            variant="primary"
            size="sm"
            testId="agents-new"
            tabIndex={0}
            onClick={() => navigate({ kind: 'library', tab: 'agent' })}
          >
            New agent
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="cb-composition-content cb-agents-content">
          {/* The roster's click OPENS the agent — its page, on the Runs tab
            (M55.12); on this surface an agent is a destination, not a
            filter. The fleet lives here alone since M50.5; Knowledge's old
            runs deep link still renders the filtering copy, and has no tab of
            its own. */}
          <section data-section="fleet" className="flex flex-col gap-2">
            <h2 className="cb-section-heading">Your agents</h2>
            <AgentRoster
              vaultPath={vaultPath}
              focus={null}
              onFocus={(actor) => {
                if (actor === null) return;
                const record = entries
                  .filter(isAgentEntry)
                  .find((e) => agentRef(e).actor === actor);
                navigate(
                  record === undefined
                    ? { kind: 'agents', actor }
                    : { kind: 'doc', path: record.path, tab: 'runs' },
                );
              }}
            />
            {/* M63.1b: what is waiting to wake them, between the roster and
              the run feed. Nested in the fleet section rather than splitting
              it, so the roster and the feed stay one section to address. */}
            <section data-section="wakes" className="my-2">
              <WakesSection vaultPath={vaultPath} />
            </section>
            <section data-section="followups" className="my-2">
              <FollowupList />
            </section>
            <h2 className="cb-section-heading">Recent runs</h2>
            <FleetSection />
          </section>
        </div>
      </div>
    </div>
  );
}
