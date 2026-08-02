import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { listConcepts, recentlyLearned } from '@/engine/okf';
import { TrustChip } from '@/knowledge/TrustChip';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The one thing Home is allowed to volunteer (M8.3).
 *
 * Everything else in cerebro waits to be asked. This does not, so it is bound
 * tightly: at most three items, only concepts written in the last fortnight
 * that no human has confirmed, and each one dismissible forever. When there is
 * nothing that qualifies the card is not rendered at all — an empty
 * "no insights" box is still something to scroll past.
 */
export function LearnedCard() {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const dismissed = useUiStore((s) => s.dismissedInsights);
  const dismiss = useUiStore((s) => s.dismissInsight);

  const today = todayIso();
  const learned = useMemo(() => {
    const concepts = listConcepts(entries, today).filter((c) => !dismissed.includes(c.entry.path));
    return recentlyLearned(concepts, new Date());
  }, [dismissed, entries, today]);

  if (learned.length === 0) return null;

  return (
    <section
      data-testid="learned-card"
      className="mb-7 rounded-[12px] border border-[var(--n-200)] bg-[var(--n-25)] p-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon name="brain" size={14} color="var(--cortex-500)" />
        <h2 className="m-0 text-[13px] font-semibold text-[var(--n-800)]">Recently learned</h2>
        <span className="text-[11.5px] text-[var(--n-500)]">nobody has confirmed these yet</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {learned.map((concept) => (
          <li
            key={concept.entry.path}
            data-testid="learned-item"
            className="flex items-center gap-1"
          >
            <button
              type="button"
              data-path={concept.entry.path}
              onClick={() =>
                navigate({ kind: 'knowledge', nav: { tab: 'all' }, path: concept.entry.path })
              }
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-[var(--n-50)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-[var(--n-800)]">
                  {concept.title}
                </span>
                {concept.description !== null && (
                  <span className="block truncate text-[11.5px] text-[var(--n-500)]">
                    {concept.description}
                  </span>
                )}
              </span>
              <TrustChip tier={concept.trust} size="sm" />
            </button>
            <IconButton
              icon="x"
              label={`Dismiss ${concept.title}`}
              size="sm"
              onClick={() => dismiss(concept.entry.path)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
