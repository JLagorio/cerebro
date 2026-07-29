import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Tag } from '@/components/ui/Tag';
import type { Concept, Source, Stamp } from '@/engine/okf';
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

const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]';

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
    <div className="flex items-center gap-1.5 text-[12px] text-[var(--n-700)]">
      <Icon name={icon} size={12} color="var(--n-500)" />
      <span className="truncate [font-family:var(--font-mono)] text-[11.5px]">{stamp.by.label}</span>
      {when !== null && <span className="flex-none text-[11px] text-[var(--n-400)]">{when}</span>}
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
      <span className="mt-[2px] inline-flex h-[15px] min-w-[15px] flex-none items-center justify-center rounded-full bg-[var(--cortex-50)] px-1 text-[9.5px] font-semibold text-[var(--cortex-600)] [font-family:var(--font-mono)]">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1">
        {external ? (
          <a
            href={source.resource}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate text-[12px] text-[var(--cortex-600)] underline decoration-[var(--cortex-200)] underline-offset-2"
          >
            {source.title ?? source.resource}
          </a>
        ) : (
          // Not every resource is followable: OKF also allows a scope
          // descriptor ("all queries in project X"), which has no link.
          <span className="block text-[12px] text-[var(--n-700)]">
            {source.title ?? source.resource}
          </span>
        )}
        {signals.length > 0 && (
          <span className="mt-0.5 block text-[11px] leading-[15px] text-[var(--n-500)]">
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
                className="flex items-center gap-1.5 text-[12px] text-[var(--n-400)]"
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
              className="flex items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[12px] text-[var(--cortex-600)] hover:underline"
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

export function KnowledgePanel({
  concept,
  today,
  onVerify,
  onAskAgent,
  onOpenEntity,
  verifying = false,
}: {
  concept: Concept;
  today: string;
  onVerify: () => void;
  onAskAgent: () => void;
  onOpenEntity: (path: string) => void;
  verifying?: boolean;
}) {
  const lastVerified = relativeDay(concept.lastVerified, today);
  const alreadyReviewed = concept.trust === 'human-reviewed';

  return (
    <aside
      aria-label="Provenance"
      data-testid="knowledge-panel"
      className="flex w-[320px] flex-none flex-col overflow-y-auto border-l border-[var(--n-200)] px-4 pb-5 pt-3.5"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <TrustChip tier={concept.trust} detail={lastVerified} />
        {concept.stale && (
          <FlagChip icon="clock-alert" label={`Stale since ${concept.staleAfter}`} tone="warn" />
        )}
        {concept.lifecycle === 'deprecated' && (
          <FlagChip icon="archive" label="Deprecated" tone="muted" />
        )}
        {concept.lifecycle === 'draft' && <FlagChip icon="pencil-line" label="Draft" tone="muted" />}
      </div>

      <AboutBlock concept={concept} onOpenEntity={onOpenEntity} />

      <div className="mt-4">
        <div className={LABEL}>Written by</div>
        <div className="mt-1.5">
          {concept.generated !== null ? (
            <ActorLine stamp={concept.generated} today={today} />
          ) : (
            <span className="text-[12px] text-[var(--n-400)]">Not recorded</span>
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
            <span className="text-[12px] text-[var(--n-400)]">Nobody yet</span>
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
            className="mt-1.5 block break-all text-[11.5px] text-[var(--cortex-600)] underline decoration-[var(--cortex-200)] underline-offset-2"
          >
            {concept.resource}
          </a>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-[var(--n-100)] pt-3">
        <Button
          variant="primary"
          icon="shield-check"
          disabled={verifying}
          onClick={onVerify}
        >
          {alreadyReviewed ? 'Verify again' : 'Verify'}
        </Button>
        <Button variant="secondary" icon="sparkles" onClick={onAskAgent}>
          Ask the agent to revise
        </Button>
        <span className="text-center text-[10.5px] leading-[15px] text-[var(--n-400)]">
          The agent writes this bundle. You confirm it.
        </span>
      </div>
    </aside>
  );
}
