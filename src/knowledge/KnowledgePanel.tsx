import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Tag } from '@/components/ui/Tag';
import {
  conceptEdges,
  listConcepts,
  nearDuplicates,
  type Concept,
  type Source,
  type Stamp,
} from '@/engine/okf';
import { typeStyle } from '@/engine/typeCatalog';
import { resolveTarget } from '@/engine/wikilink';
import { FlagChip, TrustChip } from '@/knowledge/TrustChip';
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

/** "3 days ago" — freshness is what makes a trust tier actionable. */
export function relativeDay(iso: string | null, today: string): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  const now = Date.parse(`${today}T23:59:59Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function ActorLine({ stamp, today }: { stamp: Stamp; today: string }) {
  const when = relativeDay(stamp.at, today);
  const icon =
    stamp.by.kind === 'human' ? 'user-round' : stamp.by.kind === 'process' ? 'cog' : 'bot';
  return (
    <div className="flex items-center gap-1.5 text-xs text-n-700">
      <Icon name={icon} size={12} color="var(--n-500)" />
      <span className="truncate [font-family:var(--font-mono)] text-[11.5px]">
        {stamp.by.label}
      </span>
      {when !== null && <span className="flex-none text-2xs text-n-400">{when}</span>}
    </div>
  );
}

function SourceRow({ source, index }: { source: Source; index: number }) {
  const external = /^[a-z][a-z0-9+.-]*:/i.test(source.resource);
  const signals: string[] = [];
  if (source.author !== null) signals.push(source.author.label);
  if (source.usageCount !== null) {
    const window = source.usageWindow;
    const range =
      window?.from != null && window.to != null ? ` (${window.from} → ${window.to})` : '';
    // A coarse liveness signal, comparable at the alive-vs-dead and
    // order-of-magnitude level — not a precise cross-kind ranking (§5.1).
    signals.push(`${source.usageCount.toLocaleString()} uses${range}`);
  }
  if (source.lastModified !== null) signals.push(`changed ${source.lastModified}`);

  return (
    <li className="flex gap-2 py-1.5">
      <span className="mt-[2px] inline-flex h-[15px] min-w-[15px] flex-none items-center justify-center rounded-full bg-cortex-50 px-1 text-[9.5px] font-semibold text-cortex-600 [font-family:var(--font-mono)]">
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
        ) : (
          // Not every resource is followable: OKF also allows a scope
          // descriptor ("all queries in project X"), which has no link.
          <span className="block text-xs text-n-700">{source.title ?? source.resource}</span>
        )}
        {signals.length > 0 && (
          <span className="mt-0.5 block text-2xs leading-[15px] text-n-500">
            {signals.join(' · ')}
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
  if (concept.about.length === 0) return null;
  return (
    <div className="mt-4">
      <div className={LABEL}>About</div>
      <div className="mt-1.5 flex flex-col gap-1">
        {concept.about.map((target) => {
          const entry = resolveTarget(target, entries);
          const style = typeStyle(entry?.type ?? null, schema);
          if (entry === null) {
            // An anchor naming an entity that does not exist yet is legitimate
            // (OKF §6.1) — shown greyed rather than dropped, because a claim
            // about something absent is exactly what a reviewer should notice.
            return (
              <span
                key={target}
                data-testid="about-entity"
                className="flex items-center gap-1.5 text-xs text-n-400"
              >
                <Icon name="link-2-off" size={12} color="var(--n-300)" />
                <span className="truncate">{target}</span>
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
  today,
  onOpenConcept,
}: {
  concept: Concept;
  today: string;
  onOpenConcept: (path: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const concepts = useMemo(() => listConcepts(entries, today), [entries, today]);
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
        className={`mt-px flex-none text-[10.5px] font-medium uppercase tracking-[0.04em] ${
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
  onVerify,
  onAskAgent,
  onOpenEntity,
  onOpenConcept,
  verifying = false,
  verifiedToday = false,
  className = 'w-[320px] flex-none',
}: {
  concept: Concept;
  today: string;
  onVerify: () => void;
  onAskAgent: () => void;
  onOpenEntity: (path: string) => void;
  onOpenConcept: (path: string) => void;
  verifying?: boolean;
  /** This actor already stamped this concept today (M15) — a second identical
   * row in the ledger is noise, so the button says so instead of adding one. */
  verifiedToday?: boolean;
  /** How the page places this column — beside the concept, or as an overlay
   * when the canvas is too narrow for three columns. */
  className?: string;
}) {
  const lastVerified = relativeDay(concept.lastVerified, today);
  const alreadyReviewed = concept.trust === 'human-reviewed';

  return (
    <aside
      aria-label="Provenance"
      data-testid="knowledge-panel"
      className={`flex flex-col overflow-y-auto border-l border-n-200 bg-n-0 px-4 pb-5 pt-3.5 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <TrustChip tier={concept.trust} detail={lastVerified} />
        {concept.stale && (
          <>
            <FlagChip icon="clock-alert" label={`Stale since ${concept.staleAfter}`} tone="warn" />
            {/* M15: verifying does NOT clear staleness — `stale_after` is the
                agent's to move, and verify_concept may write `verified` and
                nothing else. So the remedy for the amber chip sits next to
                it, rather than leaving Verify looking like it. */}
            <button
              type="button"
              data-testid="recheck-concept"
              onClick={onAskAgent}
              className="rounded-md border border-n-200 bg-transparent px-1.5 py-0.5 text-[10.5px] text-warn-600 hover:bg-warn-50"
            >
              Recheck
            </button>
          </>
        )}
        {concept.lifecycle === 'deprecated' && (
          <FlagChip icon="archive" label="Deprecated" tone="muted" />
        )}
        {concept.lifecycle === 'draft' && (
          <FlagChip icon="pencil-line" label="Draft" tone="muted" />
        )}
      </div>

      <AboutBlock concept={concept} onOpenEntity={onOpenEntity} />

      <RelationsBlock concept={concept} today={today} onOpenConcept={onOpenConcept} />

      <div className="mt-4">
        <div className={LABEL}>Written by</div>
        <div className="mt-1.5">
          {concept.generated !== null ? (
            <ActorLine stamp={concept.generated} today={today} />
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
            concept.verified.map((stamp, i) => <ActorLine key={i} stamp={stamp} today={today} />)
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
              <SourceRow key={source.id ?? i} source={source} index={i} />
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
            className="mt-1.5 block break-all text-[11.5px] text-cortex-600 underline decoration-cortex-200 underline-offset-2"
          >
            {concept.resource}
          </a>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-n-100 pt-3">
        {/* M15: "Verify again" invited a second identical stamp, which is
            what filled the ledger above with duplicate rows. Once you have
            signed off today there is nothing left for you to add. */}
        <Button
          variant="primary"
          icon="shield-check"
          disabled={verifying || verifiedToday}
          onClick={onVerify}
        >
          {verifiedToday ? 'Verified by you today' : alreadyReviewed ? 'Verify again' : 'Verify'}
        </Button>
        <Button variant="secondary" icon="sparkles" onClick={onAskAgent}>
          Ask the agent to revise
        </Button>
        <span className="text-center text-[10.5px] leading-[15px] text-n-400">
          The agent writes this bundle. You confirm it.
        </span>
      </div>
    </aside>
  );
}
