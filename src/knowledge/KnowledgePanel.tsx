import { useMemo, useState, type ReactNode } from 'react';
import { conceptSourceRow, resourceRow, type ResourceRow } from '@/agent/elements/decisionsSources';
import { Source as SourceLine } from '@/components/ai/Sources';
import { Trace, TraceDescription, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { Icon } from '@/components/ui/Icon';
import { NewRecordDialog } from '@/app/CreateMenu';
import { InspectorSubhead } from '@/detail/InspectorParts';
import {
  conceptEdges,
  localDayOf,
  nearDuplicates,
  type Concept,
  type Source,
  type Stamp,
} from '@/engine/okf';
import { resolveAuthor } from '@/engine/authors';
import { typeStyle } from '@/engine/typeCatalog';
import { resolveTarget } from '@/engine/wikilink';
import { FacetChips } from '@/knowledge/FacetChips';
import { useConcepts } from '@/knowledge/useConcepts';
import type { BeliefChips } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * The provenance ledger for one concept (OKF §5): where it came from, who
 * confirmed it, and whether it is still current.
 *
 * Credibility is SHOWN, never scored. OKF records objective per-source
 * signals — author, usage count, last modified — because a score is
 * subjective, unportable between consumers, and goes stale. The reader
 * judges; the format just refuses to hide the evidence.
 */

/**
 * One group of the Details panel (owner, 2026-10-18): the inspector's subhead
 * over its rows, sentence case where the overlines were uppercase.
 */
function Group({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-3.5 first:mt-0" data-testid={testId}>
      <InspectorSubhead label={label} />
      {children}
    </div>
  );
}

/** Rows whose text sits on the tab's edge and whose hover washes past it. */
const ROWS = '-mx-2 flex flex-col gap-px';
/** One ~28px row of the panel: 14px icon, 13px text. */
const ROW = 'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-[5px] text-left text-ui';

/**
 * "3 days ago" — freshness is what makes a trust tier actionable. Counted in
 * the reader's calendar days (M52.4): `today` is a local day, so the stamp is
 * read as one too — a Verify made this morning in Sydney is still yesterday
 * in UTC, and must not read "yesterday" beside a bar that says "today".
 */
export function relativeDay(iso: string | null, today: string): string | null {
  if (iso === null) return null;
  const day = localDayOf(iso);
  if (day === null) return null;
  const then = Date.parse(`${day}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  const days = Math.round((now - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * One stamp, read as the app's own nouns (M50.3): an agent's stamp is that
 * agent and opens it, the assistant's is the Assistant and opens the panel,
 * a person is a person — by name, opening their page when exactly one page
 * answers to them (M52.3), so `human:tom-keller` reads "Tom Keller". The raw
 * stamp stays in the tooltip.
 */
export function ActorLine({
  stamp,
  today,
  onOpenEntity,
}: {
  stamp: Stamp;
  today: string;
  /** Opens a person's page. Without it, a person is a name and not a link. */
  onOpenEntity?: (path: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const when = relativeDay(stamp.at, today);
  const author = resolveAuthor(stamp.by, entries);
  // A row of the panel (owner, 2026-10-18): who, and when at the row's end.
  const whenTail = when !== null && (
    <span className="ml-auto flex-none pl-2 text-xs text-n-400">{when}</span>
  );
  if (author.kind === 'agent' || author.kind === 'assistant') {
    return (
      <button
        type="button"
        data-testid="concept-author"
        data-author={author.kind}
        title={stamp.by.raw}
        onClick={() =>
          author.kind === 'agent'
            ? navigate({ kind: 'agents', actor: author.actor })
            : setAiPanelOpen(true)
        }
        className={`${ROW} bg-transparent text-n-800 hover:bg-n-50`}
      >
        <Icon
          name={author.kind === 'agent' ? 'bot' : 'sparkles'}
          size={14}
          color="var(--synapse-500)"
        />
        <span className="truncate">{author.kind === 'agent' ? author.title : 'Assistant'}</span>
        {whenTail}
      </button>
    );
  }
  const icon =
    stamp.by.kind === 'human' ? 'user-round' : stamp.by.kind === 'process' ? 'cog' : 'bot';
  if (author.kind === 'human' && author.path !== undefined && onOpenEntity !== undefined) {
    const person = author.path;
    return (
      <button
        type="button"
        data-testid="concept-person"
        data-path={person}
        title={stamp.by.raw}
        onClick={() => onOpenEntity(person)}
        className={`${ROW} bg-transparent text-n-800 hover:bg-n-50`}
      >
        <Icon name={icon} size={14} color="var(--n-400)" />
        <span className="truncate">{author.label}</span>
        {whenTail}
      </button>
    );
  }
  return (
    <div className={`${ROW} text-n-800`} title={stamp.by.raw}>
      <Icon name={icon} size={14} color="var(--n-400)" />
      <span className="truncate">{author.label}</span>
      {whenTail}
    </div>
  );
}

/**
 * One resource as the Sources element draws it (M91.14): a web page is a
 * link out, a page of this vault opens in the app through `onOpenEntity`,
 * and anything else is its words (CV-16). Its own row of a Trace, so the
 * element's link and focus rules hold.
 */
function ResourceLine({
  row,
  onOpenEntity,
}: {
  row: ResourceRow;
  onOpenEntity: (path: string) => void;
}) {
  return (
    <Trace>
      {row.ref === null ? (
        <TraceLine title={row.resource}>
          <TraceTitle>{row.label}</TraceTitle>
          {row.target.kind === 'MissingLocal' && (
            <TraceDescription>Local source missing</TraceDescription>
          )}
        </TraceLine>
      ) : (
        <SourceLine
          source={row.ref}
          onOpenPath={onOpenEntity}
          isVaultPath={(path) => path === row.page}
        />
      )}
    </Trace>
  );
}

function SourceRow({
  source,
  index,
  today,
  onOpenEntity,
}: {
  source: Source;
  index: number;
  today: string;
  onOpenEntity: (path: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  // A vault-relative resource (`/records/…`) is a page in this vault, and
  // opens like one (M50.1) — it used to render as plain text. One rule for
  // this list and the body's citation chips (M51.5), so a source never opens
  // from one and not the other.
  const row = conceptSourceRow(source, entries);
  // Who wrote the source, in the app's nouns (M52.3) — a person by their
  // page's title, and that page one click away; the stamp in the tooltip.
  const author = source.author === null ? null : resolveAuthor(source.author, entries);
  const authorName =
    author === null
      ? null
      : author.kind === 'agent'
        ? author.title
        : author.kind === 'assistant'
          ? 'Assistant'
          : author.label;
  const person = author?.kind === 'human' ? (author.path ?? null) : null;
  // Dates as the rest of the page says them — "3d ago", as the table's
  // Updated and the byline do (M52.5) — and the dates themselves on hover.
  const day = (iso: string) => relativeDay(iso, today) ?? iso;
  const signals: string[] = [];
  const dates: string[] = [];
  if (source.usageCount !== null) {
    const window = source.usageWindow;
    const range =
      window?.from != null && window.to != null
        ? ` (${day(window.from)} to ${day(window.to)})`
        : '';
    if (window?.from != null && window.to != null) dates.push(`used ${window.from} → ${window.to}`);
    // A coarse liveness signal, comparable at the alive-vs-dead and
    // order-of-magnitude level — not a precise cross-kind ranking (§5.1).
    signals.push(`${source.usageCount.toLocaleString()} uses${range}`);
  }
  if (source.lastModified !== null) {
    signals.push(`changed ${day(source.lastModified)}`);
    dates.push(`changed ${source.lastModified}`);
  }

  return (
    <li
      data-testid="concept-source"
      data-kind={row.ref?.kind ?? (row.target.kind === 'MissingLocal' ? 'missing' : 'descriptor')}
      data-path={row.page ?? undefined}
      className="flex gap-2 py-1"
    >
      {/* The number the body's citation pill shows (M51.5), drawn the same
          way, so a [2] in the text finds its row here. */}
      <span className="mt-0.5 inline-flex h-3.5 min-w-3.5 flex-none items-center justify-center rounded-full bg-cortex-50 px-[3px] text-2xs font-semibold text-cortex-600 tabular-nums">
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ResourceLine row={row} onOpenEntity={onOpenEntity} />
        {(authorName !== null || signals.length > 0) && (
          <span className="block text-xs leading-4 text-n-500">
            {authorName !== null &&
              (person !== null ? (
                <button
                  type="button"
                  data-testid="source-author"
                  data-path={person}
                  title={source.author?.raw}
                  onClick={() => onOpenEntity(person)}
                  className="bg-transparent p-0 text-n-600 decoration-n-300 underline-offset-2 hover:text-n-800 hover:underline"
                >
                  {authorName}
                </button>
              ) : (
                <span title={source.author?.raw}>{authorName}</span>
              ))}
            {authorName !== null && signals.length > 0 && ' · '}
            <span title={dates.length === 0 ? undefined : dates.join(' · ')}>
              {signals.join(' · ')}
            </span>
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * What this concept is knowledge OF (M8.1) — the entities it anchors to.
 *
 * It sits above `Written by` because it answers the first question a reader
 * has. `sources` says where a claim came from; this says what it is about,
 * and it is the only field that gets you from the bundle back into your vault.
 */
function AboutBlock({
  concept,
  onOpenEntity,
}: {
  concept: Concept;
  onOpenEntity: (path: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  // The D1 boundary, as UI state: the agent never creates a workspace record,
  // so this can only be set by a click.
  const [promoting, setPromoting] = useState<string | null>(null);
  if (concept.about.length === 0) return null;
  return (
    <Group label="About">
      {promoting !== null && (
        <NewRecordDialog defaultTitle={promoting} onClose={() => setPromoting(null)} />
      )}
      <div className={ROWS}>
        {concept.about.map((target) => {
          const entry = resolveTarget(target, entries);
          const style = typeStyle(entry?.type ?? null, schema);
          if (entry === null) {
            // An anchor naming an entity that does not exist yet is an OPEN
            // THREAD, not a broken link (OKF §6.1, M33a.3 / D7): the base is
            // tracking something the workspace has not written up. So it
            // reads as ordinary text that happens not to be clickable — the
            // same treatment an unfollowable source gets above — rather than
            // a greyed-out broken-link glyph reporting damage. And it offers
            // Create page here (M51), where the subject is met: the subject
            // view that offered it has no row leading to it now.
            return (
              <span key={target} data-testid="about-entity" className={`${ROW} text-n-600`}>
                <Icon name="circle-dashed" size={14} color="var(--n-400)" />
                <span className="min-w-0 truncate">{target}</span>
                <button
                  type="button"
                  data-testid="promote-subject"
                  title={`Write a page for ${target}`}
                  onClick={() => setPromoting(target)}
                  className="ml-auto flex flex-none items-center gap-1 bg-transparent p-0 text-xs text-n-400 hover:text-n-800"
                >
                  <Icon name="plus" size={12} />
                  Create page
                </button>
              </span>
            );
          }
          return (
            <button
              key={target}
              type="button"
              data-testid="about-entity"
              data-path={entry.path}
              onClick={() => onOpenEntity(entry.path)}
              className={`${ROW} bg-transparent text-n-800 hover:bg-n-50`}
            >
              <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
              <span className="truncate">{entry.title}</span>
            </button>
          );
        })}
      </div>
    </Group>
  );
}

/**
 * How this concept stands to the rest of the bundle (M8.7).
 *
 * The inbound edges are the point. A concept that has been replaced is never
 * rewritten to say so — the replacement is what carries `supersedes` — so
 * without reading the graph backwards, a retired claim is indistinguishable
 * from a current one. "Replaced by" is therefore the loudest thing on this
 * panel, above provenance: who wrote it matters less than whether it still
 * stands.
 */
function RelationsBlock({
  concept,
  onOpenConcept,
}: {
  concept: Concept;
  onOpenConcept: (path: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const concepts = useConcepts();
  const edges = useMemo(
    () => conceptEdges(concept, concepts, entries),
    [concept, concepts, entries],
  );
  const duplicates = useMemo(
    () => nearDuplicates(concept, concepts, entries),
    [concept, concepts, entries],
  );

  if (edges.length === 0 && duplicates.length === 0) return null;

  // The edge first, in a column of its own so the titles line up: "Replaced
  // by" reads as the sentence it is, and stays the loudest word here.
  const row = (key: string, label: string, title: string, path: string, tone: 'warn' | 'plain') => (
    <button
      key={key}
      type="button"
      data-testid="concept-relation"
      data-path={path}
      data-label={label}
      onClick={() => onOpenConcept(path)}
      className={`${ROW} bg-transparent hover:bg-n-50`}
    >
      <span
        className={`w-20 flex-none truncate text-xs ${
          tone === 'warn' ? 'font-medium text-warn-600' : 'text-n-500'
        }`}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-n-800">{title}</span>
    </button>
  );

  return (
    <Group label="Related knowledge" testId="concept-relations">
      <div className={ROWS}>
        {edges.map((edge) =>
          row(
            `${edge.kind}:${edge.direction}:${edge.concept.entry.path}`,
            edge.label,
            edge.concept.title,
            edge.concept.entry.path,
            edge.kind === 'contradicts' || (edge.kind === 'supersedes' && edge.direction === 'in')
              ? 'warn'
              : 'plain',
          ),
        )}
        {/* Unresolved lookalikes, not asserted relations — so they read as a
            question rather than a fact, and nothing is merged on their say-so. */}
        {duplicates.map((other) =>
          row(`dup:${other.entry.path}`, 'Overlaps?', other.title, other.entry.path, 'plain'),
        )}
      </div>
    </Group>
  );
}

export function KnowledgePanel({
  concept,
  today,
  onOpenEntity,
  onOpenConcept,
  chips = null,
  className = '',
}: {
  concept: Concept;
  today: string;
  onOpenEntity: (path: string) => void;
  onOpenConcept: (path: string) => void;
  /** The three axes for this concept's belief, or null when nobody derived
   * them — a vault with no ledger, or a file the ledger does not hold. */
  chips?: BeliefChips | null;
  className?: string;
}) {
  const entries = useVaultStore((s) => s.entries);
  // What the concept describes, read as its sources are: a web address links
  // out only when it is http(s), and a vault page opens in the app (CV-16).
  const resource = concept.resource === null ? null : resourceRow(concept.resource, null, entries);
  // The Details panel of a concept page (M50.1). Its two acts and
  // its status moved to the review bar under the title in M51.3 — here is
  // the evidence behind them, a click away rather than a column wide.
  return (
    <section
      aria-label="Details"
      data-testid="knowledge-panel"
      className={`flex flex-col ${className}`}
    >
      {/* The three axes, per facet. Kept apart from the review status in the
          bar, never folded into it: whether a person looked and what rests
          underneath are different questions, and a migrated concept somebody
          verified answers "yes" to the first and "nothing" to the second. */}
      {chips !== null && (
        <Group label="What this rests on" testId="belief-axes">
          <FacetChips chips={chips} />
        </Group>
      )}

      <AboutBlock concept={concept} onOpenEntity={onOpenEntity} />

      <RelationsBlock concept={concept} onOpenConcept={onOpenConcept} />

      <Group label="Written by">
        {concept.generated !== null ? (
          <div className={ROWS}>
            <ActorLine stamp={concept.generated} today={today} onOpenEntity={onOpenEntity} />
          </div>
        ) : (
          <p className="py-[5px] text-ui text-n-400">Not recorded</p>
        )}
      </Group>

      <Group label="Verified by">
        {concept.verified.length > 0 ? (
          // Multiple entries capture INDEPENDENT checks — a human sign-off
          // and a nightly process are different claims, so both are shown.
          <div className={ROWS}>
            {concept.verified.map((stamp, i) => (
              <ActorLine key={i} stamp={stamp} today={today} onOpenEntity={onOpenEntity} />
            ))}
          </div>
        ) : concept.verifiedNotice !== null ? (
          // M23.4: the review happened, the content moved on. Say so —
          // never render a stale stamp, never pretend nobody reviewed it.
          <p data-testid="verified-notice" className="py-1 text-metadata text-n-600">
            {concept.verifiedNotice}
          </p>
        ) : (
          <p className="py-[5px] text-ui text-n-400">Nobody yet</p>
        )}
      </Group>

      {concept.sources.length > 0 && (
        <Group label="Sources">
          <ul className="flex flex-col">
            {concept.sources.map((source, i) => (
              <SourceRow
                key={source.id ?? i}
                source={source}
                index={i}
                today={today}
                onOpenEntity={onOpenEntity}
              />
            ))}
          </ul>
        </Group>
      )}

      {/* Words, not chips: the panel's values read as text. */}
      {concept.tags.length > 0 && (
        <Group label="Tags" testId="concept-tags">
          <p className="flex flex-wrap gap-x-2 py-1 text-ui text-n-700">
            {concept.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </p>
        </Group>
      )}

      {resource !== null && (
        <Group label="Resource">
          <div className="py-1">
            <ResourceLine row={resource} onOpenEntity={onOpenEntity} />
          </div>
        </Group>
      )}
    </section>
  );
}
