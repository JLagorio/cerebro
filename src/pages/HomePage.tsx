import { HomeLanes } from './home/HomeLanes';
import { useMemo } from 'react';
import { StarterOffer } from '@/app/StarterOffer';
import { Icon } from '@/components/ui/Icon';
import { collectionsTree, nodeCount } from '@/engine/collections';
import type { CollectionNode } from '@/engine/types';
import { LearnedCard } from '@/knowledge/LearnedCard';
import { useNavStore } from '@/stores/navStore';
import { useLauncherStore } from '@/stores/launcherStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import './pages.css';

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** One root Collection (M12.5 — the grid used to be projects). */
export function CollectionCard({ node }: { node: CollectionNode }) {
  const navigate = useNavStore((s) => s.navigate);
  const count = nodeCount(node);

  return (
    <button
      type="button"
      data-testid="home-collection-card"
      onClick={() => navigate({ kind: 'collection', folder: node.id })}
      className="cb-home-collection"
    >
      <span className="cb-home-collection-icon">
        <Icon name={node.icon} size={19} color={node.color ?? 'var(--n-500)'} />
      </span>
      <span className="cb-home-collection-copy">
        <span className="truncate text-md font-medium text-n-900">{node.label}</span>
        <span className="text-xs text-[var(--text-meta)]">
          {count} {count === 1 ? 'thing' : 'things'} inside
        </span>
      </span>
      <Icon name="chevron-right" size={14} color="var(--text-meta)" />
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
  const openAssistant = useUiStore((s) => s.openAssistantCanvas);
  const search = useUiStore((s) => s.setQuickOpen);
  const startCreate = useLauncherStore((s) => s.startCreate);

  // M12.5: the grid shows Collections — the containers — where it used to
  // show a hardcoded Project type nobody has anymore.
  const roots = useMemo(
    () => collectionsTree(collections, views, entries, schema),
    [collections, views, entries, schema],
  );

  const greeting = greetingForHour(new Date().getHours());

  return (
    <div className="cb-home min-w-0 flex-1 overflow-y-auto bg-n-0">
      <div className="cb-home-content">
        <header className="cb-home-welcome">
          <span className="cb-home-eyebrow">Your workspace</span>
          <h1>{greeting}</h1>
          <p>A little space to think. Everything you’re working on, close at hand.</p>
        </header>

        <button type="button" className="cb-home-ask" onClick={openAssistant}>
          <span className="cb-home-ask-icon">
            <Icon name="sparkles" size={21} />
          </span>
          <span className="cb-home-ask-copy">
            <span>What would you like to work on?</span>
            <span>Think it through with your assistant</span>
          </span>
          <span className="cb-home-ask-arrow">
            <Icon name="arrow-up-right" size={19} />
          </span>
        </button>
        <div className="cb-home-actions" aria-label="Workspace actions">
          <button type="button" onClick={() => startCreate('page')}>
            <Icon name="file-plus" size={16} /> New page
          </button>
          <button type="button" onClick={() => startCreate('whiteboard')}>
            <Icon name="pen-tool" size={16} /> New whiteboard
          </button>
          <button type="button" onClick={() => search(true)}>
            <Icon name="search" size={16} /> Find something
          </button>
        </div>

        <StarterOffer />

        <HomeLanes />

        <LearnedCard />

        <div className="cb-home-collections-heading">
          <h2 className={SECTION_HEADING}>Collections</h2>
          <span className="text-xs text-[var(--text-meta)]">
            {roots.length} {roots.length === 1 ? 'collection' : 'collections'}
          </span>
        </div>
        <div className="cb-home-collections">
          {roots.map((node) => (
            <CollectionCard key={node.id} node={node} />
          ))}
        </div>
      </div>
    </div>
  );
}
