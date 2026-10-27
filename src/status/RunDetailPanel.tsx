import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  pagesWritten,
  pageWriteWords,
  PAGES_NOT_RECORDED,
  SHELL_NOT_RECORDED,
  WROTE_NO_PAGES,
  writtenPath,
  type RunPageWrites,
} from '@/engine/attribution';
import { actorLabel } from '@/engine/authors';
import { instantText } from '@/engine/whenText';
import type { Entry, Selection } from '@/engine/types';
import {
  fleetRunOrigin,
  runKnowledgeWrites,
  type FleetRefusal,
  type FleetRun,
  type FleetRunDetail,
  type RunWrite,
  type RunOrigin,
} from '@/lib/ipc';
import { useNavStore, usePaneId } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import {
  requestLeave,
  reserveLeaveIntent,
  finishLeaveIntent,
  type LeaveIntent,
} from '@/app/leaveGuard';
import { RunTranscript } from './RunTranscript';
import { RunConfiguration } from './RunConfiguration';
import { RunWhy } from './RunWhy';

/**
 * One run, opened (M33.5).
 *
 * **Why this is not `DetailPanel`.** The plan suggested reusing the record
 * detail chrome. That chrome is bound to a vault ENTRY — `detailPath`,
 * `useEntry`, a title you can rename and a BlockNote body — and a run has
 * none of those. Fitting one through it would mean inventing an entry-shaped
 * object for something that is not a record, which is the type special-casing
 * AGENTS.md forbids, arrived at from the other direction. A run is
 * operational; it gets an operational panel.
 *
 * **Every absent join says it is absent.** `cost_components: null` means no
 * rows were recorded for this run — pre-M31.6, or a path M31.6 does not cover
 * — and renders "not recorded". It never renders as $0, and an individual
 * component with no `observed_cost_micros` never renders as free either.
 * The proposal counters follow the same rule (M49.9): `null` is a run nothing
 * ever booked, and it reads "not recorded" — never "0 applied", and never a
 * "still waiting" count computed from zeros nobody measured. So do the why
 * (M56.7: "why not recorded") and the model (M56.9): `model_id: null` reads
 * "not recorded", never a guess at the default. A run with no Claude Code
 * session says its transcript was not recorded, and one whose session file
 * could not be read says that, never an empty thread (`RunTranscript`). The
 * pages it wrote (M58.1b) follow its booked writes: a run from before they
 * were booked reads "Pages written: not recorded", never "Wrote no pages",
 * and a run whose plan let the shell write adds "Shell changes not
 * recorded", so it never reads complete — and never "Wrote no pages",
 * since a shell write books no page row.
 *
 * **Refused is measured.** Refusals have been recorded with their run since
 * M54.9, so an empty list reads "No refusal recorded for this run." A code
 * is worded by turning its underscores into spaces, never from a table of
 * codes kept here (CV-04); a list the cap cut says how many more there are.
 */

/** Micros to a readable amount. Only ever called with a recorded value —
 * the absent case is handled before this, by saying so in words. */
function micros(value: number): string {
  return `$${(value / 1_000_000).toFixed(4)}`;
}

/**
 * What the run changed in Knowledge (M50.3) — the concepts its proposals
 * named, each one a page, with what became of the proposal. The counters
 * above said "2 applied" and named nothing. `null` (a vault that keeps no
 * ledger, or a read that failed) is said as not recorded; `[]` is a run
 * measured to have changed nothing here.
 */
interface OriginNavigation {
  origin: RunOrigin | 'loading';
  entries: Entry[];
  open: (selection: Selection) => void;
}

// An activation may outlive its source presentation when its own accepted
// vault switch replaces that presentation. New run selections/activations
// still supersede the handed-off destination across separate panel instances.
let latestRunActivation = 0;
interface RunActivation {
  sequence: number;
  leaveIntent: LeaveIntent;
  switchTo: string | null;
  handedOff: boolean;
}
interface RunActivationOwner {
  identity: string;
  valid: boolean;
  mounted: boolean;
  pending: RunActivation | null;
}

function KnowledgeChanged({ runId, navigation }: { runId: string; navigation: OriginNavigation }) {
  const { origin, entries, open } = navigation;
  const vaultPath = origin !== 'loading' && origin.kind === 'registered' ? origin.vault : null;
  const [attempt, setAttempt] = useState(0);
  const [writes, setWrites] = useState<RunWrite[] | null | 'loading' | 'unavailable'>('loading');
  useEffect(() => {
    if (vaultPath === null) {
      return;
    }
    let live = true;
    setWrites('loading');
    runKnowledgeWrites(vaultPath, runId).then(
      (found) => live && setWrites(found),
      () => live && setWrites('unavailable'),
    );
    return () => {
      live = false;
    };
  }, [vaultPath, runId, attempt]);

  return (
    <section className="flex flex-col gap-1" data-testid="run-detail-knowledge">
      <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">Knowledge</h5>
      {origin === 'loading' ? (
        <p role="status">Resolving the run's origin…</p>
      ) : origin.kind === 'unavailable' ? (
        <p>Knowledge is unavailable without the run's registered origin.</p>
      ) : origin.kind === 'not_recorded' ? (
        <Absent what="Knowledge origin" />
      ) : writes === 'loading' ? (
        <p role="status">Loading Knowledge changes…</p>
      ) : writes === 'unavailable' ? (
        <p>
          Couldn't read what this run changed in Knowledge.{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry Knowledge
          </button>
        </p>
      ) : writes === null ? (
        <Absent what="What it changed in Knowledge" />
      ) : writes.length === 0 ? (
        <p className="text-2xs text-n-500">Changed nothing in Knowledge.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {writes.map((w) => (
            <li key={w.path}>
              <button
                type="button"
                data-testid="run-detail-knowledge-write"
                data-path={w.path}
                onClick={() => open({ kind: 'doc', path: w.path })}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-2xs hover:bg-n-100"
              >
                <span className="min-w-0 truncate text-cortex-600">
                  {entries.find((e) => e.path === w.path)?.title ?? w.path}
                </span>
                <span className="flex-none text-n-500">{w.state}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The pages the run wrote (M58.1b), each opening its page. Knowledge pages
 * stay in the Knowledge section below, and a comment changes no page. Only a
 * run whose writes were all booked (`recorded`) can say it wrote none; a
 * `partial` run with no page rows says only that its shell changes were not
 * recorded (CV-05).
 */
function PagesWritten({
  wrote,
  navigation,
}: {
  wrote: RunPageWrites;
  navigation: OriginNavigation;
}) {
  const { entries, origin, open } = navigation;
  const canOpen = origin !== 'loading' && origin.kind === 'registered';
  if (wrote.state === 'not_recorded') {
    return (
      <section
        className="flex flex-col gap-1"
        data-testid="run-detail-pages"
        data-state="not_recorded"
      >
        <p className="text-2xs text-n-500">{PAGES_NOT_RECORDED}</p>
      </section>
    );
  }
  const pages = pagesWritten(wrote.writes);
  return (
    <section
      className="flex flex-col gap-1"
      data-testid="run-detail-pages"
      data-state={wrote.state}
    >
      <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
        Pages written
      </h5>
      {pages.length === 0 ? (
        wrote.state === 'recorded' && <p className="text-2xs text-n-500">{WROTE_NO_PAGES}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {pages.map((w) => {
            const path = writtenPath(w);
            const title = entries.find((e) => e.path === path)?.title ?? path;
            return (
              <li key={path}>
                {w.kind === 'vault.delete' || !canOpen ? (
                  <span
                    data-testid="run-detail-page"
                    data-path={path}
                    title={w.at}
                    className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-2xs text-n-600"
                  >
                    <span className="min-w-0 truncate">{title}</span>
                    <span className="flex-none text-n-500">
                      {pageWriteWords(w)}
                      {w.approved_by !== null && ' · you allowed it'}
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid="run-detail-page"
                    data-path={path}
                    title={w.at}
                    onClick={() => open({ kind: 'doc', path })}
                    className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-2xs hover:bg-n-100"
                  >
                    <span className="min-w-0 truncate text-cortex-600">{title}</span>
                    <span className="flex-none text-n-500">
                      {pageWriteWords(w)}
                      {w.approved_by !== null && ' · you allowed it'}
                    </span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {wrote.state === 'partial' && (
        <p data-testid="run-detail-shell-unrecorded" className="text-2xs text-n-500">
          {SHELL_NOT_RECORDED}
        </p>
      )}
    </section>
  );
}

/**
 * A recorded instant, as the reader's wall clock (M52.3) — Started and Ended
 * said `2026-07-28T09:02:00Z` and made a person convert it. The runtime writes UTC
 * with a `Z`, so the parse is exact; the ISO stays in the `title`. A stamp
 * that will not parse comes back verbatim rather than as a confident wrong
 * time, the same rule `relativeWhen` keeps.
 */
function Stamp({ iso }: { iso: string }) {
  return (
    <dd className="inline" title={iso}>
      {instantText(iso)}
    </dd>
  );
}

/**
 * Why the run started (M56.7), with the page it was about when there is one
 * (D18: the subject opens its page) and, for a schedule's fire, when it was
 * due beside when it started.
 */
function Why({ run, navigation }: { run: FleetRun; navigation: OriginNavigation }) {
  const { entries, origin, open } = navigation;
  const activeVault = useVaultStore((s) => s.vaultPath);
  const cause = run.cause;
  const subject = cause?.subject ?? null;
  const page = subject === null ? undefined : entries.find((e) => e.path === subject);
  return (
    <div data-testid="run-detail-why" className="flex flex-col gap-0.5 text-2xs text-n-600">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="flex-none text-n-500">Why</span>
        <RunWhy cause={cause} startedAt={run.started_at} />
      </div>
      {subject !== null && (
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="flex-none text-n-500">About</span>
          {origin === 'loading' ||
          origin.kind !== 'registered' ||
          (origin.vault === activeVault && page === undefined) ? (
            <span data-testid="run-detail-subject" className="min-w-0 truncate">
              {subject}
            </span>
          ) : (
            <button
              type="button"
              data-testid="run-detail-subject"
              data-path={subject}
              onClick={() => open({ kind: 'doc', path: subject })}
              className="min-w-0 truncate border-0 bg-transparent p-0 text-left text-2xs text-cortex-600 hover:underline"
            >
              {page?.title ?? subject}
            </button>
          )}
        </div>
      )}
      {cause?.due_at != null && (
        <span data-testid="run-detail-due" className="text-n-500">
          <span title={cause.due_at}>due {instantText(cause.due_at)}</span> ·{' '}
          <span title={run.started_at}>started {instantText(run.started_at)}</span>
        </span>
      )}
    </div>
  );
}

/** One refusal, worded by its own fields: the surface, the code with its
 * underscores as spaces, and what Rust said. */
function Refusal({ refusal }: { refusal: FleetRefusal }) {
  return (
    <li
      data-testid="run-detail-refusal"
      data-code={refusal.code}
      data-surface={refusal.surface}
      title={refusal.recorded_at}
      className="text-2xs text-n-600"
    >
      <span className="[font-family:var(--font-mono)] text-n-500">{refusal.surface}</span>
      {' · '}
      <span className="text-n-700">{refusal.code.replace(/_/g, ' ')}</span>
      {' — '}
      {refusal.detail}
    </li>
  );
}

function Refused({ refusals, total }: { refusals: FleetRefusal[]; total: number }) {
  const more = total - refusals.length;
  return (
    <section className="flex flex-col gap-1" data-testid="run-detail-refused">
      <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">Refused</h5>
      {refusals.length === 0 ? (
        <p className="text-2xs text-n-500">No refusal recorded for this run.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {refusals.map((refusal, i) => (
            <Refusal key={`${refusal.recorded_at}-${i}`} refusal={refusal} />
          ))}
        </ul>
      )}
      {more > 0 && (
        <p data-testid="run-detail-refused-more" className="text-2xs text-n-500">
          and {more} more not shown
        </p>
      )}
    </section>
  );
}

function Absent({ what }: { what: string }) {
  return (
    <p className="text-2xs text-n-500" data-testid="detail-absent">
      {what} — not recorded for this run.
    </p>
  );
}

export function RunDetailPanel({
  detail,
  onClose,
}: {
  detail: FleetRunDetail;
  onClose: () => void;
}) {
  const navigate = useNavStore((s) => s.navigate);
  const paneId = usePaneId();
  const activeEntries = useVaultStore((s) => s.entries);
  const activeVault = useVaultStore((s) => s.vaultPath);
  const vaultStatus = useVaultStore((s) => s.status);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const { run, cost_components: components, assembly, model_id: model } = detail;
  const identity = JSON.stringify([run.run_id, run.vault_id]);
  const activationOwner = useRef<RunActivationOwner | null>(null);
  useLayoutEffect(() => {
    if (activationOwner.current) {
      activationOwner.current.valid = false;
      const pending = activationOwner.current.pending;
      if (pending) finishLeaveIntent(pending.leaveIntent);
    }
    latestRunActivation += 1;
    const owner: RunActivationOwner = { identity, valid: true, mounted: true, pending: null };
    activationOwner.current = owner;
    return () => {
      owner.mounted = false;
      const pending = owner.pending;
      // Only an already accepted switch to this exact vault can hand off a
      // destination. Retirement while resolving origin or awaiting saves
      // cancels before the store can mutate the active vault.
      if (
        owner.valid &&
        pending !== null &&
        pending.switchTo !== null &&
        pending.switchTo === useVaultStore.getState().vaultPath
      )
        pending.handedOff = true;
      else {
        owner.valid = false;
        if (pending) finishLeaveIntent(pending.leaveIntent);
      }
    };
  }, [identity]);
  const close = () => {
    if (activationOwner.current) {
      activationOwner.current.valid = false;
      const pending = activationOwner.current.pending;
      if (pending) finishLeaveIntent(pending.leaveIntent);
    }
    onClose();
  };
  const [originRead, setOriginRead] = useState<{ id: string | null; value: RunOrigin } | null>(
    null,
  );
  const [originAttempt, setOriginAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setOriginRead(null);
    void fleetRunOrigin(run.vault_id).then(
      (value) => live && setOriginRead({ id: run.vault_id, value }),
      () => live && setOriginRead({ id: run.vault_id, value: { kind: 'unavailable' } }),
    );
    return () => {
      live = false;
    };
  }, [run.vault_id, originAttempt]);
  const origin = originRead?.id === run.vault_id ? originRead.value : 'loading';
  const entries =
    origin !== 'loading' &&
    origin.kind === 'registered' &&
    activeVault === origin.vault &&
    entriesVault === origin.vault
      ? activeEntries
      : [];
  const open = (selection: Selection) => {
    if (origin === 'loading' || origin.kind !== 'registered') return;
    const owner = activationOwner.current;
    if (!owner?.valid || !owner.mounted || owner.identity !== identity) return;
    const leaveIntent = reserveLeaveIntent(`pane:${paneId}`);
    const activation: RunActivation = {
      sequence: ++latestRunActivation,
      leaveIntent,
      switchTo: null,
      handedOff: false,
    };
    owner.pending = activation;
    const stillCurrent = () =>
      leaveIntent.isCurrent() &&
      owner.valid &&
      owner.pending === activation &&
      latestRunActivation === activation.sequence &&
      (owner.mounted || activation.handedOff);
    void (async () => {
      let navigationQueued = false;
      try {
        // Re-resolve on activation: a removed registry entry must not become
        // a same-path navigation in the currently open vault.
        const resolved = await fleetRunOrigin(run.vault_id);
        if (!stillCurrent()) return;
        if (resolved.kind !== 'registered') {
          setOriginRead({ id: run.vault_id, value: resolved });
          return;
        }
        if (useVaultStore.getState().vaultPath !== resolved.vault) {
          activation.switchTo = resolved.vault;
          await useVaultStore.getState().openVault(resolved.vault, { stillCurrent, leaveIntent });
        }
        if (!stillCurrent()) return;
        const current = useVaultStore.getState();
        if (
          current.vaultPath !== resolved.vault ||
          current.status !== 'ready' ||
          current.entriesVault !== resolved.vault
        )
          return;
        // The same-vault route can itself wait for a save. Keep the intent
        // alive through that existing barrier, including close/replacement.
        navigationQueued = true;
        requestLeave(
          leaveIntent,
          () => {
            // An accepted vault switch allocates a fresh pane. The source
            // pane's bound action cannot navigate that retired pane ID.
            if (activation.switchTo !== null) useNavStore.getState().navigate(selection);
            else navigate(selection);
            if (owner.pending === activation) owner.pending = null;
          },
          stillCurrent,
        );
      } catch {
        if (stillCurrent())
          useUiStore.getState().toast("Couldn't open this run's originating vault.");
      } finally {
        if (!navigationQueued) {
          finishLeaveIntent(leaveIntent);
          if (owner.pending === activation) owner.pending = null;
        }
      }
    })();
  };
  const navigation: OriginNavigation = { origin, entries, open };
  // Who ran it, in the app's nouns (M52.3); an agent's name opens its page.
  const who = actorLabel(run.actor, entries);
  const agent = who.actor;
  const metered = run.usage_state === 'exact';
  const { proposals_submitted: submitted, applied, rejected } = run;
  const booked = submitted !== null && applied !== null && rejected !== null;
  // Only a booked row can say what is still undecided.
  const waiting = booked ? submitted - applied - rejected : 0;

  return (
    <div
      data-testid="run-detail"
      data-run={run.run_id}
      className="flex flex-col gap-2 rounded-lg border border-n-300 bg-n-50 p-3"
    >
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-semibold text-n-800" title={who.raw ?? undefined}>
          {agent === undefined || origin === 'loading' || origin.kind !== 'registered' ? (
            who.text
          ) : (
            <button
              type="button"
              data-testid="run-detail-agent"
              onClick={() => open({ kind: 'agents', actor: agent })}
              className="border-0 bg-transparent p-0 text-xs font-semibold text-n-800 hover:text-cortex-600"
            >
              {who.text}
            </button>
          )}
        </h4>
        <span className="text-2xs text-n-500">
          {run.lane} · {run.mode}
        </span>
        <button
          type="button"
          className="ml-auto text-2xs text-n-500 hover:text-n-800"
          onClick={close}
          data-testid="run-detail-close"
        >
          Close
        </button>
      </div>

      {origin === 'loading' ? (
        <p role="status">Resolving origin…</p>
      ) : origin.kind === 'not_recorded' ? (
        <p>Origin not recorded.</p>
      ) : origin.kind === 'unavailable' ? (
        <p>
          Origin unavailable. This run's vault is not registered or could not be read.{' '}
          <button type="button" onClick={() => setOriginAttempt((n) => n + 1)}>
            Retry origin
          </button>
        </p>
      ) : (
        <p className="text-2xs text-n-500">Origin: {origin.vault}</p>
      )}
      <Why run={run} navigation={navigation} />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-2xs text-n-600">
        <div>
          <dt className="inline text-n-500">Started </dt>
          <Stamp iso={run.started_at} />
        </div>
        <div>
          <dt className="inline text-n-500">Ended </dt>
          {/* A run still going has no end, and an em dash is the honest
              placeholder — "now" would be a claim nothing recorded. */}
          {run.ended_at === null ? <dd className="inline">—</dd> : <Stamp iso={run.ended_at} />}
        </div>
        <div>
          <dt className="inline text-n-500">Outcome </dt>
          <dd className="inline">{run.outcome.replace(/_/g, ' ')}</dd>
        </div>
        <div>
          <dt className="inline text-n-500">Tokens </dt>
          <dd className="inline">
            {metered
              ? `${run.input_tokens.toLocaleString()} in · ${run.output_tokens.toLocaleString()} out`
              : 'unknown'}
          </dd>
        </div>
        <div>
          <dt className="inline text-n-500">Proposals </dt>
          <dd className="inline" data-testid="run-detail-proposals">
            {booked
              ? `${submitted} submitted · ${applied} applied · ${rejected} rejected`
              : 'not recorded'}
          </dd>
        </div>
        <div>
          <dt className="inline text-n-500">Model </dt>
          {model === null ? (
            <dd className="inline" data-testid="run-detail-model">
              not recorded
            </dd>
          ) : (
            <dd
              className="inline [font-family:var(--font-mono)]"
              data-testid="run-detail-model"
              title="as Claude Code reported it"
            >
              {model}
            </dd>
          )}
        </div>
      </dl>

      <RunConfiguration
        key={JSON.stringify([identity, origin, activeVault, entriesVault, vaultStatus])}
        runId={run.run_id}
        vault={
          origin !== 'loading' &&
          origin.kind === 'registered' &&
          activeVault === origin.vault &&
          entriesVault === activeVault &&
          vaultStatus === 'ready'
            ? origin.vault
            : null
        }
        foreign={
          origin !== 'loading' && origin.kind === 'registered' && activeVault !== origin.vault
        }
      />

      <RunTranscript
        key={run.run_id}
        runId={run.run_id}
        sessionId={run.cli_session_id}
        running={run.outcome === 'running'}
      />

      <Refused refusals={detail.refusals} total={detail.refusals_total} />

      <PagesWritten wrote={detail.wrote} navigation={navigation} />

      <KnowledgeChanged
        key={JSON.stringify([run.run_id, origin])}
        runId={run.run_id}
        navigation={navigation}
      />

      <section className="flex flex-col gap-1">
        <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">Cost</h5>
        {components === null ? (
          <Absent what="Cost components" />
        ) : (
          <table className="w-full text-2xs">
            <thead className="text-left text-n-500">
              <tr>
                <th className="font-medium">Component</th>
                <th className="font-medium">Quantity</th>
                <th className="font-medium">Observed</th>
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <tr
                  key={component.component}
                  data-testid="cost-component"
                  data-component={component.component}
                  data-estimated={component.estimated}
                >
                  <td>
                    {component.component}
                    {component.estimated && <span className="text-warn-600"> (estimated)</span>}
                  </td>
                  <td className="tabular-nums">
                    {component.quantity.toLocaleString()} {component.unit}
                  </td>
                  <td className="tabular-nums">
                    {component.observed_cost_micros === null ? (
                      // Absent, not free. A dash here would read as zero.
                      <span className="text-n-500">not recorded</span>
                    ) : (
                      micros(component.observed_cost_micros)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">Assembly</h5>
        {assembly === null ? (
          <Absent what="Assembly metrics" />
        ) : (
          <dl
            className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-2xs text-n-600"
            data-testid="assembly-metrics"
          >
            <div>
              <dt className="inline text-n-500">Stakes </dt>
              <dd className="inline">{assembly.intended_stakes}</dd>
            </div>
            <div>
              <dt className="inline text-n-500">Sources </dt>
              <dd className="inline">{assembly.source_count}</dd>
            </div>
            <div>
              <dt className="inline text-n-500">Evidence </dt>
              <dd className="inline">{assembly.evidence_item_count}</dd>
            </div>
            <div>
              <dt className="inline text-n-500">Latency </dt>
              <dd className="inline">
                {assembly.answer_latency_micros === null
                  ? 'not recorded'
                  : `${(assembly.answer_latency_micros / 1000).toFixed(0)} ms`}
              </dd>
            </div>
          </dl>
        )}
      </section>

      {/* A run that queued proposals has somewhere to send you. A run that
          queued none does not, and a dead link would be worse than none. */}
      {waiting > 0 && (
        <button
          type="button"
          data-testid="run-detail-to-review"
          disabled={origin === 'loading' || origin.kind !== 'registered'}
          className="self-start rounded-xs border border-n-300 px-2 py-1 text-2xs text-n-700 hover:bg-n-100"
          onClick={() => open({ kind: 'knowledge', nav: { tab: 'review' } })}
        >
          {waiting} still waiting on a decision
        </button>
      )}
    </div>
  );
}
