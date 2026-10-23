import { StateMessage } from '@/components/ui/StateMessage';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { runDuration, runForest, runStatus, type RunNode } from '@/agent/elements/runs';
import { StepIcon } from '@/components/ai/StepLine';
import { TraceDescription, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { Select } from '@/components/ui/Select';
import { actorLabel, CONSTRUCT_ACTORS } from '@/engine/authors';
import type { Entry } from '@/engine/types';
import { relativeWhen } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetFilter, FleetRun, FleetRunDetail } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { RunDetailPanel } from './RunDetailPanel';
import { RunWhy } from './RunWhy';
import './runs.css';

/**
 * The run history — one level under the roster (M33.5, re-homed in M33b.3).
 *
 * This replaces `PipelinePage`'s activity log, which was a 50-row table of
 * every vault's runs with no filter, no attribution and no way to open one.
 *
 * **It is no longer what the tab is ABOUT.** M33b.3 put `AgentRoster` above
 * it: a list of runs answers "what happened" and the question a person
 * arrives with is "who works here". So this is the history behind that
 * roster, and clicking an agent narrows it to that agent's runs. It stays
 * complete rather than becoming per-agent — work that no agent record owns
 * (the internal constructs, an unattributed chat turn) has nowhere else to be
 * visible, and a history that hid it would be a worse answer than the one it
 * replaced.
 *
 * **Nothing here is a persona.** The internal constructs appear as run
 * HISTORY, labelled "Background ingest" and the like, never as standing
 * agents with faces — a face implies memory and judgment a batched run does
 * not have (D6, and M26's name-discipline trap).
 *
 * **Every actor reads in the app's own nouns (M52.3).** A row, the actor
 * filter and the opened run name an agent by its record's title and the
 * attended assistant as the Assistant (`actorLabel`); the raw stamp is in the
 * `title`, and the filter's VALUES stay raw, because that is what the query
 * matches on.
 *
 * **Absent is never zero, in three separate places.** A run nobody attributed
 * reads "unattributed"; a run whose usage was lost reads "unknown" rather
 * than the zeros sitting in its columns; a run with no cost rows reads "not
 * recorded" rather than $0. The old activity log could express exactly one of
 * these, and could not tell "nothing has run" from "we could not read the
 * runs" at all. M49.9 adds a fourth: a run whose proposal counters nothing
 * ever booked reads "proposals not recorded" rather than "0 applied". M56.7
 * adds a fifth: a run nobody recorded a cause for reads "why not recorded".
 *
 * The read is SELECT-only and recomputed on every filter change. Nothing is
 * cached, so this list cannot drift from what the database holds.
 *
 * **A run is a trace line (M91.14).** Its state is its icon, its ink and,
 * for a screen reader, a word before it; a running run's name carries the
 * working light; how long it took shows only when both its ends were
 * recorded (an abandoned run's end is the sweep's, so it shows none). A hop stands under the run that caused it (`parent_run_id`), on
 * the trace's rule, rather than where its own start would put it; a hop whose
 * parent the filters left out is a row of its own.
 */

const MODES = ['attended', 'ambient'].map((mode) => ({ value: mode, label: mode }));

type Option = { value: string; label: string };

type State = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; runs: FleetRun[] };

/** A select that reads as a filter chip. `''` is "any", which is the absence
 * of a filter rather than a value — `Filter`'s fields are optional in Rust
 * for the same reason. The DS `Select`, not a raw `<select>` (M42.4): raw
 * controls are what made this surface look like a settings form. */
function Chip({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (next: string) => void;
}) {
  // Generated, not `fleet-filter-<id>`: two panes can each hold this section.
  const control = useId();
  return (
    <span className="flex items-center gap-1 text-metadata text-(--text-meta)">
      <label htmlFor={control}>{label}</label>
      <Select
        id={control}
        testId={`fleet-filter-${id}`}
        size="sm"
        value={value}
        onChange={onChange}
        options={[{ value: '', label: 'any' }, ...options]}
      />
    </span>
  );
}

export function FleetSection({
  focusActor = null,
  now = new Date(),
}: {
  /** The agent the roster above has selected, if any (M33b.3). It drives the
   * same actor filter a person can set by hand — one filter, one meaning —
   * so clearing the chip and clearing the selection are the same act. */
  focusActor?: string | null;
  /** Injected so a pinned clock governs "3 hours ago", the same `VAULT_TODAY`
   * discipline the e2e specs follow. */
  now?: Date;
} = {}) {
  const selection = useNavStore((s) => s.selection);
  const entries = useVaultStore((s) => s.entries);
  // The run a link asked for, if any (M33.7; re-homed under Knowledge in
  // M33a.2, where "what has run" is a tab rather than a section of a hub).
  const requested =
    selection.kind === 'knowledge' && selection.nav?.tab === 'runs' ? selection.nav.run : undefined;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [mode, setMode] = useState('');
  const [lane, setLane] = useState('');
  const [actor, setActor] = useState('');
  const [open, setOpen] = useState<FleetRunDetail | null>(null);

  // The roster's selection drives the chip rather than shadowing it. A second
  // piece of state meaning "which actor" is how a list ends up filtered by one
  // thing while the chip claims another.
  useEffect(() => {
    setActor(focusActor ?? '');
  }, [focusActor]);

  // Absent fields rather than nulls: an empty chip is no filter at all.
  const filter = useMemo<FleetFilter>(
    () => ({
      ...(mode === '' ? {} : { mode }),
      ...(lane === '' ? {} : { lane }),
      ...(actor === '' ? {} : { actor }),
    }),
    [mode, lane, actor],
  );

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', runs: await ipc.fleetRuns(filter) });
    } catch {
      // NOT the empty state. "Nothing has run" and "we could not read the
      // runs" are opposite sentences, and the surface this replaces could
      // only say the first one.
      setState({ kind: 'unavailable' });
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every actor the page can currently offer: the constructs, which exist
  // whether or not they have run — so "has ingest run at all?" is answered
  // with a no rather than by a missing option — plus whatever else this page
  // is holding, the chosen one included: an agent the roster picked before
  // it ever ran still names itself on the chip. Labelled in words, valued
  // raw: the query matches the stamp.
  const actorOptions = useMemo(() => {
    const seen = new Set(CONSTRUCT_ACTORS.map((c) => c.actor));
    if (state.kind === 'ready') {
      for (const run of state.runs) if (run.actor !== null) seen.add(run.actor);
    }
    if (actor !== '') seen.add(actor);
    return [...seen]
      .map((raw) => ({ value: raw, label: actorLabel(raw, entries).text }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [state, entries, actor]);

  const laneOptions = useMemo(() => {
    const seen = new Set<string>();
    if (state.kind === 'ready') for (const run of state.runs) seen.add(run.lane);
    if (lane !== '') seen.add(lane);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [state, lane]);

  const openRun = useCallback(async (runId: string) => {
    try {
      setOpen(await ipc.fleetRunDetail(runId));
    } catch {
      // A detail that will not open is not worth a toast behind a surface
      // (the store-layer rule); the row stays closed and the list stands.
      // This is also the honest landing for a device-local log entry naming
      // a run THIS database never had — nothing opens, nothing lies.
      setOpen(null);
    }
  }, []);

  useEffect(() => {
    if (requested === undefined) return;
    void openRun(requested);
  }, [requested, openRun]);

  return (
    <div className="flex flex-col gap-2" data-testid="fleet-section">
      <div className="flex flex-wrap items-center gap-3">
        <Chip id="mode" label="mode" value={mode} options={MODES} onChange={setMode} />
        <Chip id="lane" label="lane" value={lane} options={laneOptions} onChange={setLane} />
        <Chip id="actor" label="actor" value={actor} options={actorOptions} onChange={setActor} />
      </div>

      {state.kind === 'loading' && (
        <StateMessage state="loading" title="Reading recent runs…" compact />
      )}

      {state.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="text-metadata text-(--text-meta)">
          The run history could not be read, so nothing here is a statement about what has run.
        </p>
      )}

      {state.kind === 'ready' && state.runs.length === 0 && (
        <p data-testid="section-empty" className="text-metadata text-(--text-meta)">
          Nothing has run under these filters.
        </p>
      )}

      {state.kind === 'ready' &&
        runForest(state.runs).map((node) => (
          // A table row, not a card (M42.4): a hairline under each chain,
          // wash on hover, and the border box gone with it.
          <div
            key={node.run.run_id}
            className="cb-fleet-chain border-b border-n-100 last:border-b-0"
          >
            <FleetChain node={node} entries={entries} now={now} onOpen={openRun} />
          </div>
        ))}

      {open !== null && <RunDetailPanel detail={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** A run's row, then the hops it caused, each a row of its own on the rule. */
function FleetChain({
  node,
  entries,
  now,
  onOpen,
}: {
  node: RunNode<FleetRun>;
  entries: Entry[];
  now: Date;
  onOpen: (runId: string) => Promise<void>;
}) {
  return (
    <>
      <FleetRow run={node.run} entries={entries} now={now} onOpen={onOpen} />
      {node.hops.length > 0 && (
        <div className="cb-run-hops" data-hops={node.run.run_id}>
          {node.hops.map((hop) => (
            <FleetChain
              key={hop.run.run_id}
              node={hop}
              entries={entries}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </>
  );
}

function FleetRow({
  run,
  entries,
  now,
  onOpen,
}: {
  run: FleetRun;
  entries: Entry[];
  now: Date;
  onOpen: (runId: string) => Promise<void>;
}) {
  const who = actorLabel(run.actor, entries);
  const status = runStatus(run.outcome);
  const took = runDuration(run);
  return (
    <button
      type="button"
      data-testid="fleet-row"
      data-run={run.run_id}
      data-outcome={run.outcome}
      className="flex w-full rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-n-50"
      onClick={() => void onOpen(run.run_id)}
    >
      <TraceLine status={status.trace} statusText={status.statusText} className="cb-run-line">
        <StepIcon state={status.state} icon={status.icon} />
        {/* NULL is a category, not a blank; the stamp is a hover away. */}
        <TraceTitle
          data-testid="fleet-actor"
          title={who.raw ?? undefined}
          className="flex-1 text-ui text-n-800"
        >
          {who.text}
        </TraceTitle>
        {/* WHEN. Carried from M33.1–.10: these rows said who, what lane,
          what outcome and what it cost, and never once said when — so a run
          from this morning and one from March read identically, and "newest
          first" was an ordering nobody could verify. The exact stamp stays in
          the title; the visible text is the one a reader can act on. */}
        <span
          data-testid="fleet-when"
          title={run.started_at}
          className="whitespace-nowrap text-metadata text-(--text-meta)"
        >
          {relativeWhen(run.started_at, now)}
        </span>
        {/* WHY it started (M56.7), in Rust's words, and how late a schedule's
          fire ran. A row from before reads "why not recorded". */}
        <RunWhy cause={run.cause} startedAt={run.started_at} />
        <span className="text-metadata text-(--text-meta)">{run.lane}</span>
        {/* Sentence case: the DS reserves capitals for eyebrows, and an
          outcome is a fact, not a headline (M42.4). */}
        <span
          className="rounded-md px-1.5 py-0.5 text-metadata text-n-600"
          style={{ border: '1px solid var(--n-200)' }}
          data-testid="fleet-outcome"
        >
          {status.words}
        </span>
        {/* How long it took, only when both its ends were recorded. */}
        {took !== undefined && (
          <TraceDescription
            data-testid="fleet-took"
            title={`${run.started_at} → ${run.ended_at ?? ''}`}
            className="text-metadata"
          >
            {took}
          </TraceDescription>
        )}
        <span className="tabular-nums text-metadata text-n-600">
          {run.usage_state === 'exact' ? (
            `${(run.input_tokens + run.output_tokens).toLocaleString()} tokens`
          ) : (
            // The zeros in the columns are not a measurement.
            <span data-testid="usage-unknown">unknown</span>
          )}
        </span>
        <span className="tabular-nums text-metadata text-(--text-meta)">
          {run.applied === null || run.rejected === null ? (
            // Nothing booked these before M49.9; the zeros the row was
            // inserted with are not a measurement.
            <span data-testid="proposals-unrecorded">proposals not recorded</span>
          ) : (
            `${run.applied} applied · ${run.rejected} rejected`
          )}
        </span>
      </TraceLine>
    </button>
  );
}
