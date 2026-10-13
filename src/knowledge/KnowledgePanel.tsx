import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Tag } from '@/components/ui/Tag';
import { NewRecordDialog } from '@/app/CreateMenu';
import {
  conceptEdges,
  localDayOf,
  nearDuplicates,
  type Concept,
  type Source,
  type Stamp,
} from '@/engine/okf';
import { sourceTarget } from '@/editor/citations';
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

const LABEL = 'text-2xs font-semibold uppercase tracking-[0.06em] text-n-500';

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
  const whenTail = when !== null && <span className="flex-none text-2xs text-n-400">{when}</span>;
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
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent p-0 text-left text-xs text-n-700 hover:text-cortex-600"
      >
        <Icon
          name={author.kind === 'agent' ? 'bot' : 'sparkles'}
          size={12}
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
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent p-0 text-left text-xs text-n-700 hover:text-cortex-600"
      >
        <Icon name={icon} size={12} color="var(--n-500)" />
        <span className="truncate">{author.label}</span>
        {whenTail}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-n-700" title={stamp.by.raw}>
      <Icon name={icon} size={12} color="var(--n-500)" />
      <span className="truncate">{author.label}</span>
      {whenTail}
    </div>
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
  const target = sourceTarget(source.resource, entries);
  const external = target !== null && 'external' in target;
  const internal =
    target !== null && 'internal' in target
      ? (entries.find((e) => e.path === target.internal) ?? null)
      : null;
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
    <li className="flex gap-2 py-1.5">
      <span className="mt-[2px] inline-flex h-[15px] min-w-[15px] flex-none items-center justify-center rounded-full bg-cortex-50 px-1 text-2xs font-semibold text-cortex-600 [font-family:var(--font-mono)]">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1">
        {external ? (
          <a
            href={source.resource}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate text-xs text-cortex-600 underline decoration-cortex-200 underline-offset-2"
          >
            {source.title ?? source.resource}
          </a>
        ) : internal !== null ? (
          <button
            type="button"
            data-testid="concept-source"
            data-path={internal.path}
            onClick={() => onOpenEntity(internal.path)}
            className="block max-w-full truncate border-0 bg-transparent p-0 text-left text-xs text-cortex-600 hover:underline"
          >
            {source.title ?? internal.title}
          </button>
        ) : (
          // Not every resource is followable: OKF also allows a scope
          // descriptor ("all queries in project X"), which has no link.
          <span className="block text-xs text-n-700">{source.title ?? source.resource}</span>
        )}
        {(authorName !== null || signals.length > 0) && (
          <span className="mt-0.5 block text-2xs leading-[15px] text-n-500">
            {authorName !== null &&
              (person !== null ? (
                <button
                  type="button"
                  data-testid="source-author"
                  data-path={person}
                  title={source.author?.raw}
                  onClick={() => onOpenEntity(person)}
                  className="border-0 bg-transparent p-0 text-2xs text-n-600 hover:text-cortex-600 hover:underline"
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
      </span>
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
    <div className="mt-4">
      <div className={LABEL}>About</div>
      {promoting !== null && (
        <NewRecordDialog defaultTitle={promoting} onClose={() => setPromoting(null)} />
      )}
      <div className="mt-1.5 flex flex-col gap-1">
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
            // `+ Create page` here (M51), where the subject is met: the
            // subject view that offered it has no row leading to it now.
            return (
              <span
                key={target}
                data-testid="about-entity"
                className="flex items-center gap-1.5 text-xs text-n-700"
              >
                <Icon name="circle-dashed" size={12} color="var(--n-500)" />
                <span className="truncate">{target}</span>
                <button
                  type="button"
                  data-testid="promote-subject"
                  onClick={() => setPromoting(target)}
                  className="ml-auto flex-none border-0 bg-transparent p-0 text-2xs text-n-500 hover:text-cortex-600"
                >
                  + Create page
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
              className="flex items-center gap-1.5 border-0 bg-transparent p-0 text-left text-xs text-cortex-600 hover:underline"
            >
              <Icon name={style.icon} size={12} color={style.color ?? 'var(--n-500)'} />
              <span className="truncate">{entry.title}</span>
            </button>
          );
        })}
      </div>
    </div>
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

  const row = (key: string, label: string, title: string, path: string, tone: 'warn' | 'plain') => (
    <button
      key={key}
      type="button"
      data-testid="concept-relation"
      data-path={path}
      data-label={label}
      onClick={() => onOpenConcept(path)}
      className="flex w-full min-w-0 items-start gap-1.5 rounded-md border-0 bg-transparent px-1 py-1 text-left hover:bg-n-50"
    >
      <span
        className={`mt-px flex-none text-2xs font-medium uppercase tracking-[0.04em] ${
          tone === 'warn' ? 'text-warn-600' : 'text-n-400'
        }`}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-cortex-600">{title}</span>
    </button>
  );

  return (
    <div className="mt-4" data-testid="concept-relations">
      <div className={LABEL}>Related knowledge</div>
      <div className="mt-1.5 flex flex-col gap-px">
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
    </div>
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
  // The Details tab of a concept page's side panel (M50.1). Its two acts and
  // its status moved to the review bar under the title in M51.3 — here is
  // the evidence behind them, a click away rather than a column wide.
  return (
    <section
      aria-label="Details"
      data-testid="knowledge-panel"
      className={`flex flex-col px-1.5 pb-3 pt-1.5 ${className}`}
    >
      {/* The three axes, per facet. Kept apart from the review status in the
          bar, never folded into it: whether a person looked and what rests
          underneath are different questions, and a migrated concept somebody
          verified answers "yes" to the first and "nothing" to the second. */}
      {chips !== null && (
        <div data-testid="belief-axes">
          <div className={LABEL}>What this rests on</div>
          <div className="mt-1.5">
            <FacetChips chips={chips} />
          </div>
        </div>
      )}

      <AboutBlock concept={concept} onOpenEntity={onOpenEntity} />

      <RelationsBlock concept={concept} onOpenConcept={onOpenConcept} />

      <div className="mt-4">
        <div className={LABEL}>Written by</div>
        <div className="mt-1.5">
          {concept.generated !== null ? (
            <ActorLine stamp={concept.generated} today={today} onOpenEntity={onOpenEntity} />
          ) : (
            <span className="text-xs text-n-400">Not recorded</span>
          )}
        </div>
      </div>

      <div className="mt-4">
        <div className={LABEL}>Verified by</div>
        <div className="mt-1.5 flex flex-col gap-1">
          {concept.verified.length > 0 ? (
            // Multiple entries capture INDEPENDENT checks — a human sign-off
            // and a nightly process are different claims, so both are shown.
            concept.verified.map((stamp, i) => (
              <ActorLine key={i} stamp={stamp} today={today} onOpenEntity={onOpenEntity} />
            ))
          ) : concept.verifiedNotice !== null ? (
            // M23.4: the review happened, the content moved on. Say so —
            // never render a stale stamp, never pretend nobody reviewed it.
            <span data-testid="verified-notice" className="text-xs text-n-600">
              {concept.verifiedNotice}
            </span>
          ) : (
            <span className="text-xs text-n-400">Nobody yet</span>
          )}
        </div>
      </div>

      {concept.sources.length > 0 && (
        <div className="mt-4">
          <div className={LABEL}>Sources</div>
          <ul className="m-0 mt-1 list-none p-0">
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
        </div>
      )}

      {concept.tags.length > 0 && (
        <div className="mt-4">
          <div className={LABEL}>Tags</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {concept.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        </div>
      )}

      {concept.resource !== null && (
        <div className="mt-4">
          <div className={LABEL}>Resource</div>
          <a
            href={concept.resource}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1.5 block break-all text-xs text-cortex-600 underline decoration-cortex-200 underline-offset-2"
          >
            {concept.resource}
          </a>
        </div>
      )}
    </section>
  );
}
