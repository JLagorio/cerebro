import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { recheckLine, type Concept } from '@/engine/okf';
import { actorLabel } from '@/engine/authors';
import { useConcepts } from '@/knowledge/useConcepts';
import * as ipc from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import type {
  ChangesView,
  LanesView,
  LaneView,
  TriggerEntryStatus,
  TriggerRunReport,
} from '@/lib/ipc';
import { AgentRoster } from '@/status/AgentRoster';
import { FleetSection } from '@/status/FleetSection';
import { NeedsYouSection } from '@/status/NeedsYouSection';
import { SystemSection } from '@/status/SystemSection';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What Knowledge says about itself — the Activity and System sections of the
 * Knowledge page (M51.1), plus the proposal cards its Review tab holds. Each
 * section is its own mount that owns its own read and its own failure.
 *
 * **Nothing here computes an epistemic answer.** Lane names, the sentence
 * under each lane, the reason on every item and every line of what changed
 * arrive composed from Rust, beside the rules that produced them. This file
 * chooses layout, says the empty cases out loud, and puts a concept's title
 * where the wire sent its id (M52.3) — a reader follows "Sync error rate",
 * not `metrics/sync-error-rate.md`. The one sentence it swaps is a recheck
 * the concept's own file dates (M52.5): "Due a recheck · 2 days overdue",
 * `recheckLine`'s words on its row and its page, where Rust's "past its
 * recheck date" was a third way of saying it.
 *
 * **Separate reads, separate failures.** A vault with no ledger can still
 * show its review queue and its budget, and a section whose read failed says
 * so instead of rendering the empty state. "No open contradictions" and "we
 * could not tell you whether anything is contested" are opposite sentences.
 *
 * **No counts in the nav chrome.** A badge would be the chrome nagging somebody
 * to drain a queue — the same rule that kept a review count off Knowledge
 * (M8.1) and a commit count off History (M9.4).
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
    <section data-testid="base-section" data-section={id} className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-n-800">{title}</h2>
        {/* §33 made visible — as a quiet lock beside the name, with the
            guarantee in words for a hover and a screen reader. An uppercase
            ALWAYS SHOWN tag read as a setting's name, not as a promise. */}
        {protectedLane && (
          <span
            data-testid="protected-badge"
            className="inline-flex items-center self-center text-n-400"
            title="Always listed — no setting can hide this"
          >
            <Icon name="lock" size={11} />
            <span className="sr-only">Always listed — no setting can hide this</span>
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

const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

/**
 * The concept a lane item or a change line is about (M52.3): the file the
 * wire names as its subject's projection (bundle-relative, so under
 * `knowledge/`; a change line carries one since M52.4), else the ONE concept
 * whose file name is the entity id — two would be a guess. Null when nothing
 * in the bundle answers.
 */
function conceptNamed(
  concepts: Concept[],
  path: string | null,
  entityId: string | null,
): Concept | null {
  if (path !== null) {
    const projected = concepts.find((c) => c.entry.path === `knowledge/${path}`);
    if (projected !== undefined) return projected;
  }
  if (entityId === null) return null;
  const named = concepts.filter((c) => stem(c.entry.path) === entityId);
  return named.length === 1 ? named[0] : null;
}

/**
 * What a row is about, by name (M52.3). A concept is its title, and opens its
 * page — the same act as every other concept link on the Knowledge page. A
 * subject no concept answers to reads as the neutral "A claim" (M52.4): the
 * ids are the ledger's 32 hex characters, not slugs, so there are no words in
 * one to recover, and a humanized id is a raw id in costume. The raw id stays
 * in the `title`.
 */
function ConceptName({
  concept,
  id,
  className,
}: {
  concept: Concept | null;
  /** The ledger id the row carries, for the tooltip only. */
  id: string;
  /** Size and layout only — the colour is what tells a link from a name. */
  className: string;
}) {
  const navigate = useNavStore((s) => s.navigate);
  if (concept === null) {
    return (
      <span data-testid="activity-claim" title={id} className={`text-n-800 ${className}`}>
        A claim
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="activity-concept"
      data-path={concept.entry.path}
      title={id}
      onClick={() => navigate({ kind: 'doc', path: concept.entry.path })}
      className={`cursor-pointer border-0 bg-transparent p-0 text-left text-cortex-600 underline decoration-cortex-200 underline-offset-2 hover:decoration-cortex-500 ${className}`}
    >
      {concept.title}
    </button>
  );
}

/** A line that leads — a change line with no subject, or a lane item's
 * reason — starts with a capital. Rust composes a subjectless change line as
 * a whole sentence (`ChangeLine`'s rule in `status.rs`) and a reason as the
 * end of one; the capital is set here, so neither reads as a fragment. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The default attention setting's per-list cap (`preferences.rs`,
 * `Verbosity::Normal`) — only for choosing the sentence that explains a
 * withheld count; the cap itself is applied in Rust. */
const LANE_CAP = 10;

/**
 * A lane item's reason line. A recheck whose only reason is the concept's own
 * date reads as the concept's row and page read it (`recheckLine`); every
 * other reason is Rust's sentence, capitalised.
 */
function reasonLine(item: LaneView['items'][number], concept: Concept | null, today: string) {
  const onlyStale = item.reasons.length === 1 && item.reasons[0] === 'freshness_stale';
  return onlyStale && concept?.stale === true
    ? recheckLine(concept, today)
    : sentence(item.reason_text);
}

function Lane({ lane }: { lane: LaneView }) {
  const concepts = useConcepts();
  const today = todayIso();
  return (
    <Section id={lane.id} title={lane.label} blurb={lane.blurb} protectedLane={lane.protected}>
      {lane.items.length === 0 ? (
        <Quiet text={lane.empty_text} />
      ) : (
        // Rows between rules that run the tab's width, as the update log's
        // day rules do (M52.5): one measure for Activity. The 880px boxes
        // stopped halfway across beside rules that ran to the edge.
        <div
          data-testid="lane-items"
          className="flex flex-col divide-y divide-n-100 border-y border-n-100"
        >
          {lane.items.map((item) => {
            const concept = conceptNamed(concepts, item.path, item.entity_id);
            return (
              <div
                key={`${item.belief_id}:${item.predicate ?? ''}:${item.edge_id ?? item.relation_id ?? ''}`}
                data-testid="lane-item"
                data-lane={lane.id}
                data-reasons={item.reasons.join(' ')}
                className="flex flex-col gap-0.5 py-2"
              >
                {/* What it is, then which of its claims (M52.5): the scope is
                    a quiet qualifier on the name — only for a belief with
                    more than one — and the reason leads its own line. */}
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <ConceptName
                    concept={concept}
                    id={item.belief_id}
                    className="min-w-0 truncate text-xs font-medium"
                  />
                  {item.scope_text !== null && (
                    <span data-testid="lane-scope" className="min-w-0 truncate text-2xs text-n-500">
                      · {item.scope_text}
                    </span>
                  )}
                </span>
                <span data-testid="lane-reason" className="text-2xs text-n-600">
                  {reasonLine(item, concept, today)}
                </span>
                {item.reliance_text !== null && (
                  <span className="text-2xs text-n-500">{item.reliance_text}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* A cap nobody can see reads as "there is nothing else" — so the
          count is said, and so is why. The default attention setting shows
          ten per list (`preferences.rs`), and nothing on screen changes it
          yet, so a full list names that rule; a shorter one was held back by
          the only other ways `present` withholds — a dismissal, or an item
          already shown recently. "2 more not shown — each list shows its
          first ten" under ONE row was a sentence contradicting its list. */}
      {lane.withheld > 0 && (
        <p data-testid="lane-withheld" className="text-2xs text-n-500">
          {lane.withheld} more not shown —{' '}
          {lane.items.length >= LANE_CAP
            ? 'each list shows its first ten.'
            : 'dismissed, or shown recently.'}
        </p>
      )}
    </Section>
  );
}

function Changes({ feed }: { feed: Feed<ChangesView> }) {
  const concepts = useConcepts();
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
            {/* Sentence case, as every other label on the page (M52.5). */}
            <span className="text-xs font-medium text-n-600">{section.label}</span>
            {/* The thing that moved, by name, then what happened to it — Rust
                composes a subject's line to follow its name (M52.4). Never a
                raw id: a line about a belief or an entity names the concept
                its `path` projects, or "A claim"; a line about neither is
                just its sentence. */}
            {section.lines.map((line, index) => (
              <p
                key={`${line.belief_id ?? line.entity_id ?? ''}:${index}`}
                data-testid="change-line"
                className="text-xs text-n-700"
              >
                {line.belief_id === null && line.entity_id === null ? (
                  sentence(line.text)
                ) : (
                  <>
                    <ConceptName
                      concept={conceptNamed(concepts, line.path, line.entity_id)}
                      id={line.belief_id ?? line.entity_id ?? ''}
                      className="font-medium"
                    />{' '}
                    {line.text}
                  </>
                )}
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
      className={`flex flex-col gap-0.5 rounded-xs border px-2.5 py-1.5 ${
        fired ? 'border-warn-700' : 'border-n-200'
      }`}
    >
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-n-800">{gate.gate}</span>
        <span className="text-2xs text-n-500">{gate.variant.replaceAll('_', ' ')}</span>
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
    'rounded-xs border border-n-200 bg-transparent px-2 py-1 text-xs text-n-800 placeholder:text-n-400';

  return (
    // The gate's name and the ledger's nouns ride on the hover and the data
    // attribute (M52.5): "R7 verification scope" and "predicate classes" were
    // the registry talking, as a heading.
    <div
      data-testid="r7-scope"
      data-gate="R7"
      title="R7 verification scope"
      className="flex flex-col gap-1.5 rounded-xs border border-n-200 p-2.5"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-n-800">What to cross-check</span>
        {!editing && (
          <button
            type="button"
            data-testid="r7-scope-open"
            onClick={openForm}
            className="rounded-xs border border-n-200 px-2 py-0.5 text-2xs text-n-800 hover:bg-n-50"
          >
            {declared.kind === 'ready' && declared.data !== null ? 'Edit' : 'Choose'}
          </button>
        )}
      </div>
      {declared.kind === 'loading' && <Loading />}
      {declared.kind === 'unavailable' && <Unavailable what="What to cross-check" />}
      {declared.kind === 'ready' && !editing && declared.data === null && (
        <p data-testid="r7-scope-none" className="text-2xs text-n-500">
          Nothing is chosen to cross-check yet, so there is nothing to count. Choose which subjects,
          and which kinds of claim, to check against more than one source.
        </p>
      )}
      {declared.kind === 'ready' && !editing && declared.data !== null && (
        <div data-testid="r7-scope-declared" className="flex flex-col gap-0.5 text-2xs text-n-600">
          <span>Subjects: {declared.data.subjects.join(', ')}</span>
          <span title="Predicate classes">
            Kinds of claim: {declared.data.predicate_classes.join(', ')}
          </span>
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
          <label className="flex flex-col gap-0.5 text-2xs text-n-600" title="Predicate classes">
            Kinds of claim, one per line
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
              className="rounded-xs border border-n-200 px-2.5 py-1 text-xs text-n-800 hover:bg-n-50 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
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
          Saved. Checks made under this choice carry the digest {digest.slice(0, 12)}….
        </p>
      )}
    </div>
  );
}

/**
 * The board, behind one line (M33a.2, spec D5/D6).
 *
 * R1–R14 rendered as a wall of "Never evaluated here" cards — 3,225px, 55% of
 * the whole Status page — to say one thing: nothing has fired. That is
 * build-planning bookkeeping, not a reading surface, so the count is what a
 * reader gets and the board is what a second question gets. The count is
 * READ off the registry rather than written here: spec D6 guessed 24 and the
 * shipped artifact declares 14 entries, which is exactly the kind of number
 * that must not be hard-coded into a sentence.
 *
 * Two things deliberately stay OUT of the collapse. A FIRING is the only news
 * this tab ever has, so it is in the summary line itself — a headline behind
 * a click is a headline nobody reads. And "Evaluate now" stays, because the
 * action is the tab's rather than the board's, and what a run did is a
 * sentence, not a row.
 *
 * D6 says this is reversible once it has been lived with, which is why the
 * board is collapsed rather than deleted.
 */
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
  const [expanded, setExpanded] = useState(false);
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') return <Unavailable what="The list of held-back features" />;
  const board = feed.data;
  const firedGates = board.flatMap((entry) =>
    entry.gates.filter((gate) => gate.latest?.result === 'fired'),
  );
  // What a firing asks for, by the capability's name: the gate's code
  // ("R13:root") rides on the hover and `data-fired` (M52.5).
  const needed = board
    .filter((entry) => entry.gates.some((gate) => gate.latest?.result === 'fired'))
    .map((entry) => entry.capability.replaceAll('_', ' '));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="gates-evaluate"
          onClick={onEvaluate}
          disabled={running}
          className="rounded-xs border border-n-200 px-2.5 py-1 text-xs text-n-800 hover:bg-n-50 disabled:opacity-50"
        >
          {running ? 'Evaluating…' : 'Evaluate now'}
        </button>
        <span
          data-testid="gates-summary"
          data-fired={firedGates.length === 0 ? undefined : firedGates.map((g) => g.gate).join(' ')}
          title={
            firedGates.length === 0
              ? undefined
              : `${firedGates.map((g) => g.gate).join(', ')} fired — a firing licenses a dated plan, never code`
          }
          className="text-2xs text-n-500"
        >
          {board.length} {board.length === 1 ? 'is' : 'are'} held back;{' '}
          {needed.length === 0
            ? 'none is needed yet'
            : `${needed.join(', ')} ${needed.length === 1 ? 'is' : 'are'} needed now`}
          .
        </span>
        {board.length > 0 && (
          <button
            type="button"
            data-testid="gates-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="text-2xs text-n-500 underline underline-offset-2 hover:text-n-700"
          >
            {expanded ? 'Hide them' : 'Show each one'}
          </button>
        )}
      </div>
      {error !== null && (
        <p data-testid="gates-run-error" className="text-2xs text-warn-700">
          {error}
        </p>
      )}
      {report !== null && <RunOutcome report={report} />}
      {expanded &&
        board.map((entry) => (
          <div
            key={entry.registry_id}
            data-testid="gate-entry"
            data-entry={entry.registry_id}
            className="flex flex-col gap-1"
          >
            <span className="text-xs font-medium text-n-600">
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
      <Section id="lanes-unavailable" title="What Knowledge is unsure of">
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

/** The proposal queue — what agents want to change in Knowledge, waiting on
 * you to decide. Named "Waiting on you" rather than "Needs review": Knowledge
 * already has a review queue, for CONCEPTS a human has not verified, and two
 * unrelated queues under one string is a nav that lies. */
export function WaitingOnYou({ vaultPath }: { vaultPath: string | null }) {
  return (
    <Section
      id="needs-review"
      title="Waiting on you"
      blurb="What agents want to change in Knowledge, waiting for you to decide."
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

/**
 * Who works here, and what they have done (M33b.3).
 *
 * The roster leads and the run history follows. It was the other way around
 * until M33b.3 — the tab listed runs, which answers "what happened" when the
 * question a person arrives with is "who works here" (spec D5). Selecting an
 * agent narrows the history to that agent's runs; the selection lives here
 * rather than inside either child, because it is the one thing they share.
 */
export function AgentWork({ vaultPath }: { vaultPath: string | null }) {
  const entries = useVaultStore((s) => s.entries);
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <Section
      id="fleet"
      title="Agents"
      blurb="Who works in this vault, what they are on, and what they have run."
    >
      {/* The roster is the vault's — agents are records — while the history
          spans vaults, because one CLI subscription runs them all and an
          agent's actor is the same string wherever it ran. */}
      <AgentRoster vaultPath={vaultPath} focus={focus} onFocus={setFocus} />
      <h3 className="pt-1 text-xs font-semibold text-n-700">
        {focus === null ? 'Every run booked here' : `Runs by ${actorLabel(focus, entries).text}`}
      </h3>
      <FleetSection focusActor={focus} />
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
      title="Features held back until they're needed"
      blurb="Each stays unbuilt until measured use shows it is needed — and then it earns a dated plan, not code."
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
