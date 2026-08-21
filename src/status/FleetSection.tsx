import { useCallback, useEffect, useMemo, useState } from 'react';
import { Select } from '@/components/ui/Select';
import { relativeWhen } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetFilter, FleetRun, FleetRunDetail } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { RunDetailPanel } from './RunDetailPanel';

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
 * HISTORY under the actor names they already answer to, never as standing
 * agents with faces — a face implies memory and judgment a batched run does
 * not have (D6, and M26's name-discipline trap).
 *
 * **Absent is never zero, in three separate places.** A run nobody attributed
 * reads "unattributed"; a run whose usage was lost reads "unknown" rather
 * than the zeros sitting in its columns; a run with no cost rows reads "not
 * recorded" rather than $0. The old activity log could express exactly one of
 * these, and could not tell "nothing has run" from "we could not read the
 * runs" at all.
 *
 * The read is SELECT-only and recomputed on every filter change. Nothing is
 * cached, so this list cannot drift from what the database holds.
 */

/** The three internal constructs, by the actor names Rust already stamps
 * (`agent::meter::CONSTRUCT_ACTORS`). Offered as filter options even before a
 * page contains one, so "has ingest run at all?" is a question the UI can
 * answer with a no rather than by omitting the option. */
const CONSTRUCT_ACTORS = ['agent:m26-ingest', 'agent:m26-maintenance', 'agent:m26-synthesis'];

const MODES = ['attended', 'ambient'];

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
  options: string[];
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-2xs text-n-500">
      {label}
      <Select
        testId={`fleet-filter-${id}`}
        size="sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={[
          { value: '', label: 'any' },
          ...options.map((option) => ({ value: option, label: option })),
        ]}
      />
    </label>
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
  // whether or not they have run, plus whatever else this page is holding.
  const actorOptions = useMemo(() => {
    const seen = new Set(CONSTRUCT_ACTORS);
    if (state.kind === 'ready') {
      for (const run of state.runs) if (run.actor !== null) seen.add(run.actor);
    }
    return [...seen].sort();
  }, [state]);

  const laneOptions = useMemo(() => {
    const seen = new Set<string>();
    if (state.kind === 'ready') for (const run of state.runs) seen.add(run.lane);
    return [...seen].sort();
  }, [state]);

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

      {state.kind === 'loading' && <p className="text-xs text-n-400">Reading…</p>}

      {state.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="text-xs text-n-500">
          The run history could not be read, so nothing here is a statement about what has run.
        </p>
      )}

      {state.kind === 'ready' && state.runs.length === 0 && (
        <p data-testid="section-empty" className="text-xs text-n-500">
          Nothing has run under these filters.
        </p>
      )}

      {state.kind === 'ready' &&
        state.runs.map((run) => (
          <button
            key={run.run_id}
            type="button"
            data-testid="fleet-row"
            data-run={run.run_id}
            data-outcome={run.outcome}
            // A table row, not a card (M42.4): hairline below, wash on hover,
            // and the border box gone with it.
            className="flex w-full items-center gap-2 rounded-md border-0 border-b border-n-100 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-n-50"
            onClick={() => void openRun(run.run_id)}
          >
            <span className="min-w-0 flex-1 truncate text-xs text-n-800">
              {/* NULL is a category, not a blank. */}
              {run.actor ?? 'unattributed'}
            </span>
            {/* WHEN. Carried from M33.1–.10: these rows said who, what lane,
                what outcome and what it cost, and never once said when — so a
                run from this morning and one from March read identically, and
                "newest first" was an ordering nobody could verify. The exact
                stamp stays in the title; the visible text is the one a reader
                can act on. */}
            <span
              data-testid="fleet-when"
              title={run.started_at}
              className="whitespace-nowrap text-2xs text-n-500"
            >
              {relativeWhen(run.started_at, now)}
            </span>
            <span className="text-2xs text-n-500">{run.lane}</span>
            {/* Sentence case: the DS reserves capitals for eyebrows, and an
                outcome is a fact, not a headline (M42.4). */}
            <span
              className="rounded-md px-1.5 py-0.5 text-2xs text-n-600"
              style={{ border: '1px solid var(--n-200)' }}
              data-testid="fleet-outcome"
            >
              {run.outcome.replace(/_/g, ' ')}
            </span>
            <span className="tabular-nums text-2xs text-n-600">
              {run.usage_state === 'exact' ? (
                `${(run.input_tokens + run.output_tokens).toLocaleString()} tokens`
              ) : (
                // The zeros in the columns are not a measurement.
                <span data-testid="usage-unknown">unknown</span>
              )}
            </span>
            <span className="tabular-nums text-2xs text-n-500">
              {run.applied} applied · {run.rejected} rejected
            </span>
          </button>
        ))}

      {open !== null && <RunDetailPanel detail={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
