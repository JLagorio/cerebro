import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { FavoriteStar } from '@/app/FavoriteStar';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { actorLabel, CONSTRUCT_ACTORS } from '@/engine/authors';
import { agentDraft, type AgentDraft } from '@/engine/libraryDraft';
import { holdsProposalTools, proposalConsequence } from '@/engine/tools';
import { instantText } from '@/engine/whenText';
import type { Entry, Selection } from '@/engine/types';
import { ConceptBody } from '@/knowledge/ConceptBody';
import { useConcepts } from '@/knowledge/useConcepts';
import * as ipc from '@/lib/ipc';
import { readNote, updateFrontmatter, type FleetRunDetail } from '@/lib/ipc';
import type { FleetRun } from '@/lib/mockIpc';
import { AgentRoster } from '@/status/AgentRoster';
import { FleetSection } from '@/status/FleetSection';
import { RunDetailPanel } from '@/status/RunDetailPanel';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

export type AgentsSelection = Extract<Selection, { kind: 'agents' }>;

/** Frontmatter stripped for the charter render — the record keeps it; the
 * grants panel beside it is the frontmatter, read properly. */
const stripFrontmatter = (body: string) => body.replace(/^---\n[\s\S]*?\n---\n?/, '');

type Read<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'unavailable' };

/** One grants row: the axis, then what the record says about it — with
 * absent-is-never-zero wording (`null` = unrestricted, `[]` = none). */
function GrantRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5 text-sm">
      <span className="w-28 flex-none text-n-500">{label}</span>
      <span className="min-w-0 flex-1 text-n-800">{value}</span>
    </div>
  );
}

function scopeWords(scope: string[] | null, anywhere: string, nowhere: string): string {
  if (scope === null) return anywhere;
  if (scope.length === 0) return nowhere;
  return scope.map((f) => `${f}/`).join(', ');
}

/**
 * What this agent may do, read from the same `agentDraft` the editor edits —
 * one parse, two geometries, so the summary can never disagree with the
 * editor about what the record says.
 */
function GrantsSummary({ draft }: { draft: AgentDraft }) {
  const consequence = holdsProposalTools(draft.allowedTools) ? proposalConsequence() : null;
  return (
    <div data-testid="agent-grants" className="rounded-lg border border-n-200 p-3">
      <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
        Grants
      </div>
      <GrantRow
        label="Writes in"
        value={scopeWords(draft.scope, 'anywhere in the vault', 'nowhere — proposals only')}
      />
      <GrantRow label="Reads" value={scopeWords(draft.readScope, 'everything', 'nothing')} />
      <GrantRow
        label="Tools"
        value={
          draft.allowedTools === null
            ? 'unrestricted'
            : `${draft.allowedTools.length} granted: ${draft.allowedTools.join(', ')}`
        }
      />
      <GrantRow
        label="Connectors"
        value={
          draft.connectors === null
            ? 'whatever the vault enabled'
            : draft.connectors.length === 0
              ? 'none'
              : draft.connectors.join(', ')
        }
      />
      {draft.shell && <GrantRow label="Shell" value="host tools, capped by the Settings ceiling" />}
      <GrantRow
        label="Schedule"
        // The roster's words (M52.3), so the row and the page agree — but
        // only "off duty" when nothing else fires it: an agent with standing
        // triggers and no schedule is on duty, on events (M52.4).
        value={
          draft.schedule === ''
            ? draft.triggers.length > 0
              ? 'none — its triggers fire it'
              : 'none — off duty, runs only when you ask'
            : draft.schedule
        }
      />
      <GrantRow
        label="Triggers"
        value={draft.triggers.length === 0 ? 'none' : `${draft.triggers.length} standing`}
      />
      {consequence !== null && (
        <p
          data-testid="agent-consequence-line"
          className="m-0 mt-2 text-xs leading-[17px] text-n-500"
        >
          Of the ops its tools reach, {consequence.applies} apply on their own and{' '}
          {consequence.queues} queue for you.
        </p>
      )}
    </div>
  );
}

/**
 * The actor's run history with its chains rendered (M41.4 — the trace
 * M34.3's `parent_run_id` has waited for). A hop names the run it hopped
 * from; a root with hops shows them indented, and the indent IS the billing
 * statement: hops bill to the root's ceiling.
 */
function RunHistory({ actor }: { actor: string }) {
  const entries = useVaultStore((s) => s.entries);
  const [runs, setRuns] = useState<Read<FleetRun[]>>({ kind: 'loading' });
  // M50.3: a run opens where it is listed. These rows were inert, so the one
  // page about an agent could not show what any of its runs did.
  const [open, setOpen] = useState<FleetRunDetail | null>(null);
  const openRun = (runId: string) => {
    if (open?.run.run_id === runId) {
      setOpen(null);
      return;
    }
    ipc.fleetRunDetail(runId).then(setOpen, () => setOpen(null));
  };

  useEffect(() => {
    let live = true;
    setRuns({ kind: 'loading' });
    void ipc.fleetRuns({ limit: 200 }).then(
      (data) => live && setRuns({ kind: 'ready', data }),
      () => live && setRuns({ kind: 'unavailable' }),
    );
    return () => {
      live = false;
    };
  }, [actor]);

  if (runs.kind === 'loading') return null;
  if (runs.kind === 'unavailable') {
    // NOT the empty state: "has not run" and "could not read the runs" are
    // opposite sentences.
    return (
      <p data-testid="agent-runs-unavailable" className="m-0 text-sm text-n-500">
        Couldn't read the run history — it can't say what this agent has done.
      </p>
    );
  }

  const all = runs.data;
  const byId = new Map(all.map((r) => [r.run_id, r]));
  const childrenOf = new Map<string, FleetRun[]>();
  for (const run of all) {
    if (run.parent_run_id === null) continue;
    const siblings = childrenOf.get(run.parent_run_id) ?? [];
    siblings.push(run);
    childrenOf.set(run.parent_run_id, siblings);
  }
  const mine = all.filter((r) => r.actor === actor);

  if (mine.length === 0) {
    return (
      <p data-testid="agent-runs-empty" className="m-0 text-sm text-n-500">
        No runs recorded for this agent.
      </p>
    );
  }

  const tokens = (run: FleetRun) =>
    run.usage_state === 'exact'
      ? `${(run.input_tokens + run.output_tokens).toLocaleString()} tokens`
      : // The zeros a lost run leaves behind are not a measurement.
        'usage unknown';

  // A hop is another worker's run, named as the app names it (M52.3); the
  // stamp the runtime recorded stays in the tooltip.
  const who = (raw: string | null) => actorLabel(raw, entries);

  const row = (run: FleetRun, hop: boolean) => (
    <button
      type="button"
      key={run.run_id}
      data-testid={hop ? 'agent-run-hop' : 'agent-run'}
      data-run={run.run_id}
      aria-expanded={open?.run.run_id === run.run_id}
      onClick={() => openRun(run.run_id)}
      className={`flex w-full items-center gap-2 rounded-md bg-transparent px-2 py-1 text-left text-sm hover:bg-n-50 ${hop ? 'ml-6 border-0 border-l-2 border-solid border-n-200' : 'border-0'}`}
    >
      {hop && <Icon name="corner-down-right" size={13} color="var(--n-400)" />}
      <span
        className="min-w-0 flex-1 truncate text-n-800"
        title={hop ? (run.actor ?? undefined) : run.started_at}
      >
        {hop ? who(run.actor).text : instantText(run.started_at)}
      </span>
      <span className="flex-none text-xs text-n-500">
        {run.lane} · {run.mode}
      </span>
      <span className="flex-none text-xs text-n-500">{tokens(run)}</span>
      <span
        className={`flex-none text-xs ${run.outcome === 'succeeded' ? 'text-n-500' : 'font-medium text-danger-600'}`}
      >
        {run.outcome}
      </span>
    </button>
  );

  return (
    <div data-testid="agent-runs" className="flex flex-col gap-0.5">
      {mine.map((run) => {
        const hops = childrenOf.get(run.run_id) ?? [];
        const parent = run.parent_run_id === null ? null : (byId.get(run.parent_run_id) ?? null);
        return (
          <div key={run.run_id}>
            {run.parent_run_id !== null && (
              <p
                data-testid="agent-run-parent"
                className="m-0 ml-2 text-xs leading-[17px] text-n-500"
              >
                ↳ a hop from{' '}
                <span title={parent?.actor ?? undefined}>
                  {parent === null ? `run ${run.parent_run_id}` : who(parent.actor).text}
                </span>{' '}
                — billed to that run's ceiling
              </p>
            )}
            {row(run, false)}
            {open?.run.run_id === run.run_id && (
              <div className="my-1">
                <RunDetailPanel detail={open} onClose={() => setOpen(null)} />
              </div>
            )}
            {hops.length > 0 && (
              <>
                {hops.map((hopRun) => row(hopRun, true))}
                <p className="m-0 ml-8 text-xs leading-[17px] text-n-400">
                  {hops.length === 1 ? 'one hop, billed' : `${hops.length} hops, billed`} to this
                  run's ceiling
                </p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What this agent has put into Knowledge (M50.3): the concepts stamped with
 * its actor — found by the stamp, never by a title — and, for the agent that
 * maintains Knowledge, the whole of it. The agent's page used to know its
 * grants and runs and nothing of what they produced, while every concept it
 * wrote named it.
 */
function AgentKnowledge({ actor, maintains }: { actor: string; maintains: boolean }) {
  const navigate = useNavStore((s) => s.navigate);
  const concepts = useConcepts();
  const wrote = concepts.filter((c) => c.generated?.by.raw === actor);
  if (wrote.length === 0 && !maintains) return null;
  return (
    <div data-testid="agent-knowledge" className="mt-6">
      <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
        Knowledge
      </div>
      {maintains && (
        <button
          type="button"
          data-testid="agent-maintains"
          onClick={() => navigate({ kind: 'knowledge', nav: { tab: 'all' } })}
          className="mb-1 inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-sm text-n-700 hover:bg-n-50"
        >
          <Icon name="brain" size={14} color="var(--synapse-500)" />
          Maintains Knowledge · {concepts.length} concept{concepts.length === 1 ? '' : 's'}
        </button>
      )}
      {wrote.length === 0 ? (
        <p className="m-0 px-2 text-sm text-n-500">It has not written a concept yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {wrote.map((c) => (
            <li key={c.entry.path}>
              <button
                type="button"
                data-testid="agent-wrote"
                data-path={c.entry.path}
                onClick={() => navigate({ kind: 'doc', path: c.entry.path })}
                className="flex w-full min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-sm hover:bg-n-50"
              >
                <Icon name="lightbulb" size={13} color="var(--n-400)" />
                <span className="min-w-0 flex-1 truncate text-n-800">{c.title}</span>
                <span className="flex-none text-xs text-n-500">{c.conceptType}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One agent's page: charter, grants, duty, and its runs with their chains. */
function AgentDetail({ actor }: { actor: string }) {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const navigate = useNavStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);
  const [body, setBody] = useState<Read<string>>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const entry: Entry | undefined = useMemo(
    () => entries.filter(isAgentEntry).find((e) => agentRef(e).actor === actor),
    [entries, actor],
  );

  useEffect(() => {
    if (entry === undefined || vaultPath === null) return;
    let live = true;
    setBody({ kind: 'loading' });
    readNote(vaultPath, entry.path).then(
      (text) => live && setBody({ kind: 'ready', data: stripFrontmatter(text) }),
      () => live && setBody({ kind: 'unavailable' }),
    );
    return () => {
      live = false;
    };
  }, [entry, vaultPath]);

  if (entry === undefined) {
    // The three internal constructs (`agent::meter::CONSTRUCT_ACTORS`) are
    // permanently record-less — `meter.rs` records why — so their page says
    // so, in plain words, instead of offering an editor that could not exist.
    const construct = CONSTRUCT_ACTORS.find((c) => c.actor === actor);
    if (construct !== undefined) {
      return (
        <div className="mx-auto w-full max-w-[720px] px-6 py-5" data-testid="agent-construct">
          <p className="m-0 text-sm leading-[19px] text-n-600" title={actor}>
            <strong>{construct.label}</strong> is work Cerebro runs itself, not an agent you manage.
            It has no record and nothing to edit — what it may do is fixed in the app, not set by a
            page in your vault. Its runs are below.
          </p>
          <div className="mt-4">
            <RunHistory actor={actor} />
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

  const draft = agentDraft(entry, '');
  const paused = entry.properties.paused === true;

  const setDuty = (on: boolean) => {
    if (vaultPath === null || busy) return;
    setBusy(true);
    void (async () => {
      try {
        await updateFrontmatter(vaultPath, entry.path, { paused: on ? null : true });
        await rescan();
      } catch {
        toast("Couldn't change that");
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        {/* The mock's agent-page header (M42.4): a violet tile — synapse is
            the AI color and an agent page is an AI surface — then the name
            with its one-line brief under it, controls to the right. */}
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-synapse-50 text-synapse-500">
            <Icon name="bot" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 min-w-0 truncate text-xl font-semibold text-n-900">{entry.title}</h2>
            {draft.description !== '' && (
              <p className="m-0 mt-0.5 text-sm text-n-600">{draft.description}</p>
            )}
          </div>
          <FavoriteStar path={entry.path} />
          {paused && (
            <span
              data-testid="agent-paused-chip"
              className="flex-none rounded-full bg-n-100 px-2 py-0.5 text-xs text-n-600"
            >
              paused
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            testId="agent-duty-toggle"
            disabled={busy}
            onClick={() => setDuty(paused)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          {/* One editor, one save path: editing stays the Library's. */}
          <Button
            variant="secondary"
            size="sm"
            testId="agent-edit"
            onClick={() => navigate({ kind: 'library', tab: 'agent', path: entry.path })}
          >
            Edit
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 @[700px]/canvas:grid-cols-[1fr_320px]">
          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
              Charter
            </div>
            {body.kind === 'unavailable' ? (
              <p data-testid="agent-charter-unavailable" className="m-0 text-sm text-n-500">
                Couldn't read the record — the charter can't be shown.
              </p>
            ) : body.kind === 'ready' ? (
              <div data-testid="agent-charter">
                <ConceptBody markdown={body.data} sources={[]} fromPath={entry.path} />
              </div>
            ) : null}
          </div>
          <GrantsSummary draft={draft} />
        </div>

        <AgentKnowledge
          actor={actor}
          maintains={agentRef(entry).capabilities.includes('knowledge')}
        />

        <div className="mb-1 mt-6 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
          Runs
        </div>
        <RunHistory actor={actor} />
      </div>
    </div>
  );
}

/**
 * The agents' front door (M41).
 *
 * Configure in the Library, observe under Base, address in the panel — the
 * platform's subjects had three rooms and no house. This surface is the
 * house: the roster over the fleet's run feed, and one page per agent that
 * says what it is, what it may do, and what it has done — chains included.
 */
export function AgentsPage({ selection }: { selection: AgentsSelection }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const navigate = useNavStore((s) => s.navigate);

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="agents-page">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-n-200 px-4">
        <Icon name="bot" size={16} color="var(--n-600)" />
        <h1 className="m-0 text-lg font-semibold leading-6 tracking-[-0.005em]">Agents</h1>
        <span className="flex-1" />
        {/* Creation stays the Library's flow (born paused, M36.2) — one
            creator, one editor. This is the door to it. */}
        <Button
          variant="primary"
          size="sm"
          testId="agents-new"
          onClick={() => navigate({ kind: 'library', tab: 'agent' })}
        >
          New agent
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
        {/* The roster's click OPENS the agent here — on this surface an agent
            is a destination, not a filter. The fleet lives here alone since
            M50.5; Knowledge's old runs deep link still renders the filtering
            copy, and has no tab of its own. */}
        <section data-section="fleet" className="flex flex-col gap-2">
          <AgentRoster
            vaultPath={vaultPath}
            focus={null}
            onFocus={(actor) => {
              if (actor !== null) navigate({ kind: 'agents', actor });
            }}
          />
          <FleetSection />
        </section>
      </div>
    </div>
  );
}
