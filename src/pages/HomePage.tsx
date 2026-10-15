import { HomeLanes } from './home/HomeLanes';
import { useMemo } from 'react';
import { StarterOffer } from '@/app/StarterOffer';
import { Icon } from '@/components/ui/Icon';
import { collectionsTree, nodeCount } from '@/engine/collections';
import type { CollectionNode } from '@/engine/types';
import { LearnedCard } from '@/knowledge/LearnedCard';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const CARD =
  'flex min-w-0 flex-col gap-2 rounded-lg border border-n-200 bg-n-0 px-[14px] py-[13px] text-left hover:border-n-300 hover:shadow-[var(--shadow-sm)]';

/** One root Collection (M12.5 — the grid used to be projects). */
export function CollectionCard({ node }: { node: CollectionNode }) {
  const navigate = useNavStore((s) => s.navigate);
  const count = nodeCount(node);

  return (
    <button
      type="button"
      data-testid="home-collection-card"
      onClick={() => navigate({ kind: 'collection', folder: node.id })}
      className={CARD}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={node.icon} size={15} color={node.color ?? 'var(--n-500)'} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-md font-semibold text-n-900">
          {node.label}
        </span>
      </div>
      <div className="text-xs text-[var(--text-meta)]">
        {count} {count === 1 ? 'thing' : 'things'} inside
      </div>
    </button>
  );
}

/** One heading style for every Home section, so the visual and semantic
 *  levels agree instead of the h2s shipping at two different sizes. */
export const SECTION_HEADING = 'm-0 text-lg font-semibold tracking-[-0.005em]';

export function HomePage() {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const schema = useSchema();

  // M12.5: the grid shows Collections — the containers — where it used to
  // show a hardcoded Project type nobody has anymore.
  const roots = useMemo(
    () => collectionsTree(collections, views, entries, schema),
    [collections, views, entries, schema],
  );

  const greeting = greetingForHour(new Date().getHours());

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-n-0">
      <div className="mx-auto max-w-[1080px] px-8 pb-14 pt-8">
        <div className="mb-[18px] flex items-baseline gap-3">
          <h1 className="m-0 text-2xl font-semibold leading-[30px] tracking-[-0.015em]">
            {greeting}
          </h1>
          <span className="text-xs text-[var(--text-meta)]">
            {roots.length} {roots.length === 1 ? 'collection' : 'collections'}
          </span>
        </div>

        <StarterOffer />

        <LearnedCard />

        <HomeLanes />

        <div className="mb-2.5 flex items-center gap-2">
          <h2 className={SECTION_HEADING}>Collections</h2>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {roots.map((node) => (
            <CollectionCard key={node.id} node={node} />
          ))}
        </div>
      </div>
    </div>
  );
}
