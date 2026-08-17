import { useEffect, useState } from 'react';
import * as ipc from '@/lib/ipc';
import type {
  ChangesView,
  LanesView,
  LaneView,
  TriggerEntryStatus,
  TriggerRunReport,
} from '@/lib/ipc';
import { FleetSection } from '@/status/FleetSection';
import { NeedsYouSection } from '@/status/NeedsYouSection';
import { SystemSection } from '@/status/SystemSection';

/**
 * What the base knows about ITSELF — the Status hub's five sections, moved
 * here as Knowledge tabs (M33a.2, from `pages/EpistemicStatusPage.tsx`).
 *
 * **Why the scroll column died.** The hub stacked every section in one
 * column: 5,799px in an 844px viewport, seven screens to reach the last one.
 * `Deferral gates` alone was 3,225px — 55% of the page — of cards reading
 * "Never evaluated here." A nav that could only scroll you past four sections
 * to reach the fifth is not navigation, and the sections were never one
 * reading. Each is a tab now, and the Knowledge sidebar is the nav.
 *
 * **Why it lives under Knowledge.** What the base HOLDS and what it knows
 * about itself were two rail buttons describing one subject. A bundle that
 * cannot say what it is unsure of is not a knowledge base, it is a folder.
 *
 * **Nothing here computes an epistemic answer.** Lane names, the sentence
 * under each lane, the reason on every item and every line of what changed
 * arrive composed from Rust, beside the rules that produced them. This file
 * chooses layout and says the empty cases out loud.
 *
 * **Six tabs, six independent failures.** The feeds are deliberately separate
 * calls, and each tab now reads only its own: a vault with no ledger can
 * still show its review queue and its budget, and a section whose read failed
 * says so instead of rendering the empty state. "Nothing is contested" and
 * "we could not tell you whether anything is contested" are opposite
 * sentences.
 *
 * **No counts in the rail.** A badge would be the chrome nagging somebody to
 * drain a queue — the same rule that kept a review count off Knowledge (M8.1)
 * and a commit count off History (M9.4).
 */

/** One feed's three states. `loading` is distinct from `unavailable` so a
 * slow read never renders as a refusal. */
type Feed<T> = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: T };

function useFeed<T>(
  vaultPath: string | null,
  read: (vault: string) => Promise<T>,
  version = 0,
): Feed<T> {
  const [feed, setFeed] = useState<Feed<T>>({ kind: 'loading' });
  useEffect(() => {
    if (vaultPath === null) {
      setFeed({ kind: 'unavailable' });
      return;
    }
    let live = true;
    setFeed({ kind: 'loading' });
    void (async () => {
      try {
        const data = await read(vaultPath);
        if (live) setFeed({ kind: 'ready', data });
      } catch {
        // A read behind a surface goes quiet rather than toasting (the
        // store-layer rule in AGENTS.md), and the section says what it could
        // not find out. Nothing is retried on a timer: these tabs speak when
        // they are opened and never on their own.
        if (live) setFeed({ kind: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
    // `read` is in the deps rather than suppressed. Every call site passes a
    // module-level IPC function, so it is stable; an inline lambda would
    // re-fetch on every render, which is a defect this dependency makes loud
    // instead of hiding. `version` is the one deliberate re-read: an action
    // that changed what the feed would say bumps it.
  }, [vaultPath, read, version]);
  return feed;
}

function Section({
  id,
  title,
  blurb,
  protectedLane = false,
  children,
}: {
  id: string;
  title: string;
  blurb?: string;
  protectedLane?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section data-testid="status-section" data-section={id} className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-n-800">{title}</h2>
        {/* §33 made visible. The guarantee that no preference can hide this
            lane is worth more on screen than in a comment. */}
        {protectedLane && (
          <span
            data-testid="protected-badge"
            className="rounded px-1.5 py-0.5 text-2xs uppercase tracking-[0.06em] text-n-500"
            style={{ border: '1px solid var(--n-200)' }}
            title="Always shown. No preference can hide this."
          >
            always shown
          </span>
        )}
      </div>
      {blurb !== undefined && <p className="text-xs text-n-500">{blurb}</p>}
      <div className="flex flex-col gap-1.5 pt-0.5">{children}</div>
    </section>
  );
}

/** What a section says when its read did not come back. Never the empty
 * state: a tab that renders "no contradictions" over a failed read is
 * telling somebody something it does not know. */
function Unavailable({ what }: { what: string }) {
  return (
    <p data-testid="section-unavailable" className="text-xs text-n-500">
      {what} could not be read, so nothing here is a statement about this vault.
    </p>
  );
}

function Quiet({ text }: { text: string }) {
  return (
    <p data-testid="section-empty" className="text-xs text-n-500">
      {text}
    </p>
  );
}

function Loading() {
  return <p className="text-xs text-n-400">Reading…</p>;
}

/** The title of a lane row: the file if one projects this belief, the entity
 * otherwise. A belief id would be honest and unreadable. */
function titleOf(item: { path: string | null; entity_id: string }): string {
  return item.path ?? item.entity_id;
}

function Lane({ lane }: { lane: LaneView }) {
  return (
    <Section id={lane.id} title={lane.label} blurb={lane.blurb} protectedLane={lane.protected}>
      {lane.items.length === 0 ? (
        <Quiet text={lane.empty_text} />
      ) : (
        lane.items.map((item) => (
          <div
            key={`${item.belief_id}:${item.predicate ?? ''}:${item.edge_id ?? item.relation_id ?? ''}`}
            data-testid="lane-item"
            data-lane={lane.id}
            data-reasons={item.reasons.join(' ')}
            className="flex flex-col gap-0.5 rounded border border-n-200 px-2.5 py-2"
          >
            <span className="truncate text-xs font-medium text-n-800">{titleOf(item)}</span>
            <span className="text-2xs text-n-600">
              {item.scope_text === null
                ? item.reason_text
                : `${item.scope_text} — ${item.reason_text}`}
            </span>
            {item.reliance_text !== null && (
              <span className="text-2xs text-n-500">{item.reliance_text}</span>
            )}
          </div>
        ))
      )}
      {lane.withheld > 0 && (
        <p data-testid="lane-withheld" className="text-2xs text-n-500">
          {lane.withheld} more held back by a preference.
        </p>
      )}
    </Section>
  );
}

function Changes({ feed }: { feed: Feed<ChangesView> }) {
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') return <Unavailable what="What changed" />;
  const view = feed.data;
  if (view.quiet) {
    return <Quiet text="Nothing has changed since the last time anybody looked." />;
  }
  return (
    <>
      {view.sections
        // A quiet section inside a loud window is not news. The window-level
        // "nothing changed" above is the sentence that has to be said out
        // loud; repeating it five times would bury the two lines that moved.
        .filter((section) => section.lines.length > 0)
        .map((section) => (
          <div key={section.id} data-testid="change-section" data-change={section.id}>
            <span className="text-2xs uppercase tracking-[0.06em] text-n-500">{section.label}</span>
            {section.lines.map((line, index) => (
              <p
                key={`${line.belief_id ?? line.entity_id ?? ''}:${index}`}
                data-testid="change-line"
                className="text-xs text-n-700"
              >
                {line.entity_id ?? line.belief_id ?? ''} {line.text}
              </p>
            ))}
          </div>
        ))}
    </>
  );
}

/** What one run pass did, said in one line — plus each gate that could not
 * be evaluated or failed, because a silent skip and a recorded row are
 * different claims and the difference is the point. */
function skipText(outcome: ipc.TriggerGateOutcome): string | null {
  if (outcome.kind === 'not_evaluated') return outcome.reason;
  if (outcome.kind === 'error') return `failed — ${outcome.message}`;
  return null;
}

function RunOutcome({ report }: { report: TriggerRunReport }) {
  const recorded = report.gates.filter((g) => g.outcome.kind === 'recorded').length;
  return (
    <div data-testid="gates-run-outcome" className="flex flex-col gap-0.5">
      <p className="text-2xs text-n-600">
        Evaluated {recorded} gate{recorded === 1 ? '' : 's'}.
      </p>
      {report.gates
        .map((g) => ({ gate: g.gate, text: skipText(g.outcome) }))
        .filter((g): g is { gate: string; text: string } => g.text !== null)
        .map((g) => (
          <p key={g.gate} data-testid="gates-run-skip" className="text-2xs text-n-500">
            {g.gate}: {g.text}
          </p>
        ))}
    </div>
  );
}

/** One gate's row: key, variant, newest result or an explicit
 * never-evaluated, and the note saying what it waits for. A fired gate is
 * the loud case — and even then the sentence says what firing licenses. */
function GateRow({ gate }: { gate: ipc.TriggerGateStatus }) {
  const fired = gate.latest?.result === 'fired';
  return (
    <div
      data-testid="gate-row"
      data-gate={gate.gate}
      data-result={gate.latest?.result ?? 'never'}
      className={`flex flex-col gap-0.5 rounded border px-2.5 py-1.5 ${
        fired ? 'border-warn-700' : 'border-n-200'
      }`}
    >
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-n-800">{gate.gate}</span>
        <span className="text-2xs uppercase tracking-[0.06em] text-n-500">{gate.variant}</span>
      </span>
      <span className="text-2xs text-n-600">
        {gate.latest === null
          ? 'Never evaluated here.'
          : `${gate.latest.result.replaceAll('_', ' ')} — evaluated ${gate.latest.evaluated_at.slice(0, 10)}.`}
        {fired && ' A firing licenses a dated plan, never code.'}
      </span>
      {gate.note !== null && <span className="text-2xs text-n-500">{gate.note}</span>}
    </div>
  );
}

/** R7 is the one gate whose question is DECLARED: which subjects, which
 * predicate classes, under which constraints. The runner never invents a
 * scope, so until one is declared here R7 reports not-evaluated. The lists
 * are canonicalized (trimmed, deduplicated, byte-sorted) before they are
 * sent — the validator refuses unsorted input, and making a human hand-sort
 * entity ids would be refusing them for the wrong reason. */
function R7Scope({ vaultPath }: { vaultPath: string | null }) {
  const [version, setVersion] = useState(0);
  const declared = useFeed(vaultPath, ipc.triggerR7Scope, version);
  const [editing, setEditing] = useState(false);
  const [subjects, setSubjects] = useState('');
  const [classes, setClasses] = useState('');
  const [stage, setStage] = useState('');
  const [environment, setEnvironment] = useState('');
  const [geography, setGeography] = useState('');
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openForm = () => {
    if (declared.kind === 'ready' && declared.data !== null) {
      setSubjects(declared.data.subjects.join('\n'));
      setClasses(declared.data.predicate_classes.join('\n'));
      setStage(declared.data.stage ?? '');
      setEnvironment(declared.data.environment ?? '');
      setGeography(declared.data.geography ?? '');
    }
    setDigest(null);
    setEditing(true);
  };

  const save = () => {
    if (vaultPath === null || saving) return;
    const list = (text: string) =>
      [
        ...new Set(
          text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
        ),
        // Default sort: UTF-16 code-unit order, which is byte order for the
        // ASCII ids these lists hold — the same order the Rust validator
        // checks. localeCompare would be the wrong collation here.
      ].sort();
    const constraint = (value: string) => (value.trim() === '' ? null : value.trim());
    const scope = {
      subjects: list(subjects),
      predicate_classes: list(classes),
      stage: constraint(stage),
      environment: constraint(environment),
      geography: constraint(geography),
    };
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        setDigest(await ipc.triggerDeclareR7Scope(vaultPath, JSON.stringify(scope)));
        setEditing(false);
        setVersion((v) => v + 1);
      } catch (e) {
        // Never a throw: the validator's refusal is a sentence the person
        // fixes, not an error the page fell over on.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    })();
  };

  const field =
    'rounded border border-n-200 bg-transparent px-2 py-1 text-xs text-n-800 placeholder:text-n-400';

  return (
    <div data-testid="r7-scope" className="flex flex-col gap-1.5 rounded border border-n-200 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-n-800">R7 verification scope</span>
        {!editing && (
          <button
            type="button"
            data-testid="r7-scope-open"
            onClick={openForm}
            className="rounded border border-n-200 px-2 py-0.5 text-2xs text-n-800 hover:bg-n-50"
          >
            {declared.kind === 'ready' && declared.data !== null ? 'Edit' : 'Declare'}
          </button>
        )}
      </div>
      {declared.kind === 'loading' && <Loading />}
      {declared.kind === 'unavailable' && <Unavailable what="The R7 verification scope" />}
      {declared.kind === 'ready' && !editing && declared.data === null && (
        <p data-testid="r7-scope-none" className="text-2xs text-n-500">
          No scope is declared, so R7 has no question to count. Declare which subjects and predicate
          classes it should verify.
        </p>
      )}
      {declared.kind === 'ready' && !editing && declared.data !== null && (
        <div data-testid="r7-scope-declared" className="flex flex-col gap-0.5 text-2xs text-n-600">
          <span>Subjects: {declared.data.subjects.join(', ')}</span>
          <span>Predicate classes: {declared.data.predicate_classes.join(', ')}</span>
          {(declared.data.stage !== null ||
            declared.data.environment !== null ||
            declared.data.geography !== null) && (
            <span>
              Constraints:{' '}
              {[
                declared.data.stage !== null ? `stage ${declared.data.stage}` : null,
                declared.data.environment !== null
                  ? `environment ${declared.data.environment}`
                  : null,
                declared.data.geography !== null ? `geography ${declared.data.geography}` : null,
              ]
                .filter((part) => part !== null)
                .join(', ')}
            </span>
          )}
        </div>
      )}
      {editing && (
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-0.5 text-2xs text-n-600">
            Subjects, one entity id per line
            <textarea
              data-testid="r7-scope-subjects"
              value={subjects}
              onChange={(event) => setSubjects(event.target.value)}
              rows={3}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-2xs text-n-600">
            Predicate classes, one per line
            <textarea
              data-testid="r7-scope-classes"
              value={classes}
              onChange={(event) => setClasses(event.target.value)}
              rows={2}
              className={field}
            />
          </label>
          <div className="flex gap-1.5">
            {(
              [
                ['stage', stage, setStage],
                ['environment', environment, setEnvironment],
                ['geography', geography, setGeography],
              ] as const
            ).map(([name, value, set]) => (
              <label key={name} className="flex flex-1 flex-col gap-0.5 text-2xs text-n-600">
                {name} (optional)
                <input
                  data-testid={`r7-scope-${name}`}
                  value={value}
                  onChange={(event) => set(event.target.value)}
                  className={field}
                />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="r7-scope-save"
              onClick={save}
              disabled={saving}
              className="rounded border border-n-200 px-2.5 py-1 text-xs text-n-800 hover:bg-n-50 disabled:opacity-50"
            >
              {saving ? 'Declaring…' : 'Declare scope'}
            </button>
            <button
              type="button"
              data-testid="r7-scope-cancel"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              className="text-2xs text-n-500 hover:text-n-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <p data-testid="r7-scope-error" className="text-2xs text-warn-700">
          {error}
        </p>
      )}
      {digest !== null && (
        <p data-testid="r7-scope-digest" className="text-2xs text-n-500">
          Declared. Evaluations under this scope will carry digest {digest.slice(0, 12)}….
        </p>
      )}
    </div>
  );
}

function Gates({
  feed,
  onEvaluate,
  running,
  report,
  error,
}: {
  feed: Feed<TriggerEntryStatus[]>;
  onEvaluate: () => void;
  running: boolean;
  report: TriggerRunReport | null;
  error: string | null;
}) {
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') return <Unavailable what="The trigger registry" />;
  const board = feed.data;
  const firedGates = board.flatMap((entry) =>
    entry.gates.filter((gate) => gate.latest?.result === 'fired'),
  );
  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="gates-evaluate"
          onClick={onEvaluate}
          disabled={running}
          className="rounded border border-n-200 px-2.5 py-1 text-xs text-n-800 hover:bg-n-50 disabled:opacity-50"
        >
          {running ? 'Evaluating…' : 'Evaluate now'}
        </button>
        <span className="text-2xs text-n-500">
          {firedGates.length === 0
            ? 'Nothing has fired.'
            : `${firedGates.map((gate) => gate.gate).join(', ')} has fired.`}
        </span>
      </div>
      {error !== null && (
        <p data-testid="gates-run-error" className="text-2xs text-warn-700">
          {error}
        </p>
      )}
      {report !== null && <RunOutcome report={report} />}
      {board.map((entry) => (
        <div
          key={entry.registry_id}
          data-testid="gate-entry"
          data-entry={entry.registry_id}
          className="flex flex-col gap-1"
        >
          <span className="text-2xs uppercase tracking-[0.06em] text-n-500">
            {entry.registry_id} — {entry.capability}
          </span>
          {entry.gates.map((gate) => (
            <GateRow key={gate.gate} gate={gate} />
          ))}
          {entry.note !== null && (
            <p data-testid="gate-entry-note" className="text-2xs text-n-500">
              {entry.note}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

function Lanes({ feed }: { feed: Feed<LanesView> }) {
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') {
    return (
      <Section id="lanes-unavailable" title="Contradictions, gaps, staleness and debt">
        <Unavailable what="The attention lanes" />
      </Section>
    );
  }
  const view = feed.data;
  return (
    <>
      {view.lanes.map((lane) => (
        <Lane key={lane.id} lane={lane} />
      ))}
      {view.incomplete.map((sentence) => (
        <p key={sentence} data-testid="lanes-incomplete" className="text-2xs text-warn-700">
          {sentence}
        </p>
      ))}
    </>
  );
}

/** What moved since the last time anybody looked. */
export function WhatChanged({ vaultPath }: { vaultPath: string | null }) {
  const changes = useFeed(vaultPath, ipc.converge);
  return (
    <Section id="changed" title="What changed" blurb="Since the last time anybody looked at this.">
      <Changes feed={changes} />
    </Section>
  );
}

/**
 * The attention lanes: contradictions, blindness, staleness, epistemic debt.
 *
 * The lanes arrive NAMED by Rust and their number varies, so this renders
 * whatever the feed holds rather than enumerating four ids — a second copy of
 * a list Rust owns is the copy that drifts.
 */
export function WhatsContested({ vaultPath }: { vaultPath: string | null }) {
  const lanes = useFeed(vaultPath, ipc.attentionLanes);
  return <Lanes feed={lanes} />;
}

/** The proposal queue — what the base wants to change and is waiting on you
 * to decide. Named "Waiting on you" rather than "Needs review": Knowledge
 * already has a Needs review row, for CONCEPTS a human has not verified, and
 * two unrelated queues under one string is a nav that lies. */
export function WaitingOnYou({ vaultPath }: { vaultPath: string | null }) {
  return (
    <Section
      id="needs-review"
      title="Waiting on you"
      blurb="What the base wants to change and is waiting for you to decide."
    >
      {/* M33.3: the cards themselves, not a count and a door. The section
          owns its own read. */}
      <NeedsYouSection vaultPath={vaultPath} />
    </Section>
  );
}

/** Whether anything is running, what it has left to spend, what it holds. */
export function Background({ vaultPath }: { vaultPath: string | null }) {
  return (
    <Section
      id="system"
      title="Background"
      blurb="Whether anything is running, what it has left to spend, and what it is holding."
    >
      {/* M33.4: the controls themselves, not a two-line summary and a door.
          The section owns its own read. */}
      <SystemSection vaultPath={vaultPath} />
    </Section>
  );
}

/** Every run this app has booked, what it was for, and what it cost. */
export function AgentWork() {
  return (
    <Section
      id="fleet"
      title="What has run"
      blurb="Every run this app has booked, what it was for, and what it cost."
    >
      {/* M33.5: the fleet spans vaults, so this section takes no vault — a
          caller that wants one says so in its own filter. */}
      <FleetSection />
    </Section>
  );
}

/** What stays unbuilt until measured evidence says otherwise. */
export function DeferralGates({ vaultPath }: { vaultPath: string | null }) {
  const [gatesVersion, setGatesVersion] = useState(0);
  const gates = useFeed(vaultPath, ipc.triggerStatus, gatesVersion);
  const [running, setRunning] = useState(false);
  const [runReport, setRunReport] = useState<TriggerRunReport | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // The one action on this tab. It never throws (the store-layer rule):
  // failure becomes a sentence beside the button, and success re-reads the
  // board so the newest rows are the ones on screen.
  const evaluateNow = () => {
    if (vaultPath === null || running) return;
    setRunning(true);
    setRunError(null);
    void (async () => {
      try {
        setRunReport(await ipc.triggerRun(vaultPath));
        setGatesVersion((version) => version + 1);
      } catch (error) {
        setRunReport(null);
        setRunError(error instanceof Error ? error.message : String(error));
      } finally {
        setRunning(false);
      }
    })();
  };

  return (
    <Section
      id="gates"
      title="Deferral gates"
      blurb="What stays unbuilt until measured evidence says otherwise. A firing licenses a dated plan, never code."
    >
      <Gates
        feed={gates}
        onEvaluate={evaluateNow}
        running={running}
        report={runReport}
        error={runError}
      />
      <R7Scope vaultPath={vaultPath} />
    </Section>
  );
}
