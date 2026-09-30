import type { BeliefChips, FacetChips as FacetChipsRow } from '@/lib/ipc';

/**
 * Support / Coverage / Validity, per belief facet (M27.5c).
 *
 * **Three chips, never one number.** The axes are orthogonal on purpose: a
 * corroborated belief can be stale, a blind one can be uncontested, and a
 * score that multiplied them would destroy exactly the distinctions a person
 * needs. Nothing here combines them.
 *
 * **Every word arrives from Rust.** `support_text`, `coverage_text` and
 * `validity_text` are composed beside their derivations; this file chooses
 * placement and colour and maps nothing. A component that turned
 * `(kind, summary)` into "sources not yet assessed" would be the fold rule spelled
 * a second time in a language that never loaded the fold artifact.
 *
 * **A multi-facet belief gets separate scoped rows.** One revision can rest
 * on a claim about `ci_status` at `implemented` and another about
 * `bill_of_materials` at `shipping`; they go stale on different clocks, and a
 * merged row would have to pick one and be wrong about the other. The row
 * names its scope in words (`scopeWords`) — the one phrase here not composed
 * in Rust, because the wire carries only the key.
 */

const AXIS_TONE = {
  support: { fg: 'var(--cortex-700)', bg: 'var(--cortex-50)' },
  coverage: { fg: 'var(--info-700)', bg: 'var(--info-50)' },
  validity: { fg: 'var(--n-700)', bg: 'var(--n-100)' },
  /** Amber is reserved for the states that want a person: stale, contested,
   * blind, unsupported. Colour follows the answer, not the axis. */
  warn: { fg: 'var(--warn-700)', bg: 'var(--warn-50)' },
} as const;

function AxisChip({
  axis,
  value,
  text,
  attention,
  extra = {},
}: {
  axis: 'support' | 'coverage' | 'validity';
  value: string;
  text: string;
  attention: boolean;
  extra?: Record<string, string>;
}) {
  const tone = attention ? AXIS_TONE.warn : AXIS_TONE[axis];
  return (
    <span
      data-testid="axis-chip"
      data-axis={axis}
      data-value={value}
      {...extra}
      className="inline-flex items-center rounded-full px-2 py-[3px] text-2xs font-medium"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {text}
    </span>
  );
}

/** Words that are initials, said as initials — Rust's `INITIALISMS`. */
const INITIALISMS = new Set([
  'api',
  'arr',
  'cd',
  'ci',
  'cpu',
  'crm',
  'db',
  'eta',
  'id',
  'kpi',
  'mrr',
  'nps',
  'qa',
  'sdk',
  'sku',
  'sla',
  'slo',
  'sql',
  'sso',
  'ui',
  'url',
  'ux',
]);

/** What a facet with no recorded predicate is about — Rust's
 * `UNRECORDED_SCOPE`. It is a row and not an absence. */
const UNRECORDED_SCOPE = "what it is about isn't recorded";

/**
 * A facet in words — "CI status, at the implemented stage" — as Activity
 * says it (M52.5): Rust's `attention::status::scope_words`, which composes
 * the lane and change lines, says exactly this, and the two change together.
 * The chips' wire carries the key and not the words, so they are said here:
 * the field, initials upper-cased and the first word capitalised, and the
 * stage as a stage. An `unknown` stage is no stage.
 */
export function scopeWords(predicate: string | null, stage: string): string {
  if (predicate === null) return UNRECORDED_SCOPE;
  const field = predicate
    .split('_')
    .filter((word) => word !== '')
    .map((word, n) =>
      INITIALISMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : n === 0
          ? word.charAt(0).toUpperCase() + word.slice(1)
          : word,
    )
    .join(' ');
  return stage === 'unknown' ? field : `${field}, at the ${stage.replaceAll('_', ' ')} stage`;
}

const predicateOf = (facet: FacetChipsRow) =>
  facet.key.predicate.kind === 'known' ? facet.key.predicate.value : null;

/** What this row is about, in words. Rendered only when there is more than
 * one row, because a single facet's scope is the whole belief's scope and
 * naming it every time is noise. */
function scopeOf(facet: FacetChipsRow): string {
  const words = scopeWords(predicateOf(facet), facet.key.state_stage);
  // A row's label, so it starts with a capital, as a known field's does.
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The row's key as the ledger names it — `ci_status at implemented` — kept
 * on the element for whoever needs the code, never shown. */
function keyOf(facet: FacetChipsRow): string {
  const predicate = predicateOf(facet);
  if (predicate === null) return 'unknown';
  return facet.key.state_stage === 'unknown'
    ? predicate
    : `${predicate} at ${facet.key.state_stage}`;
}

export function FacetChipRow({ facet, showScope }: { facet: FacetChipsRow; showScope: boolean }) {
  return (
    <div data-testid="facet-chips" data-facet={keyOf(facet)} className="flex flex-col gap-1">
      {showScope && (
        // As Activity's lane rows say it: the field it names ("CI status"),
        // never its key.
        <span data-testid="facet-scope" className="text-xs font-medium text-n-600">
          {scopeOf(facet)}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <AxisChip
          axis="support"
          value={facet.support.level}
          text={facet.support_text}
          attention={facet.support.level === 'unsupported'}
        />
        <AxisChip
          axis="coverage"
          value={facet.coverage.summary}
          text={facet.coverage_text}
          attention={facet.coverage.summary === 'blind'}
          extra={{ 'data-assessed': facet.coverage.kind }}
        />
        <AxisChip
          axis="validity"
          value={facet.validity.freshness}
          text={facet.validity_text}
          attention={
            facet.validity.freshness === 'stale' || facet.validity.conflict === 'contested'
          }
          extra={{
            'data-conflict': facet.validity.conflict,
            'data-lifecycle': facet.validity.lifecycle,
          }}
        />
      </div>
    </div>
  );
}

/**
 * The same answers as one line per facet, for surfaces that list concepts
 * rather than read one.
 *
 * A dossier row is already a title, a description and a review chip; three
 * more chips per row would make a wall, and a wall is how "nothing speaks
 * first" gets broken by accretion. The sentence is the same sentence — it
 * arrives composed, and this adds only the scope when there is more than one.
 */
export function FacetLines({ chips }: { chips: BeliefChips | null }) {
  if (chips === null) return null;
  const showScope = chips.facets.length > 1;
  return (
    <>
      {chips.facets.map((facet) => (
        <span
          key={`${facet.key.belief_revision_event_id}:${keyOf(facet)}`}
          data-testid="facet-line"
          className="block truncate text-2xs text-n-500"
        >
          {showScope ? `${scopeOf(facet)} — ${facet.line}` : facet.line}
        </span>
      ))}
    </>
  );
}

/**
 * Every facet of one belief.
 *
 * `chips` is null when the surface has no answer — a vault with no ledger, or
 * a load that failed. Nothing renders then, and that is the honest reading:
 * saying "no evidence offered" about a belief nobody derived would be inventing an
 * answer. The case where the ledger IS readable and this file simply is not
 * in it is said out loud by the caller, which is the only place that knows
 * the difference.
 */
export function FacetChips({ chips }: { chips: BeliefChips | null }) {
  if (chips === null) return null;
  const showScope = chips.facets.length > 1;
  return (
    <div className="flex flex-col gap-2">
      {chips.facets.map((facet) => (
        <FacetChipRow
          key={`${facet.key.belief_revision_event_id}:${keyOf(facet)}`}
          facet={facet}
          showScope={showScope}
        />
      ))}
    </div>
  );
}
