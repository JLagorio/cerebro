import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { rowClass } from '@/app/sidebarChrome';
import { listSections, reviewQueue } from '@/engine/okf';
import type { KnowledgeNav as Nav } from '@/engine/types';
import { useConcepts } from '@/knowledge/useConcepts';
import { usePendingCards } from '@/knowledge/usePendingCards';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The Knowledge sidebar (M8.1; M51).
 *
 * What a reader navigates Knowledge BY, in the shape every other section of
 * the nav already has: its folders, the way Pages lists pages, and the one
 * queue that waits for a person. The page itself carries the rest as three
 * tabs (Concepts, Review, Activity).
 *
 * M51 retired the thread rows. Fifteen subjects — records, epics, concepts,
 * anchors nobody had written a page for — were a second index of the vault
 * inside this section, and the one question they answered ("what does
 * Knowledge hold about this?") is answered on the subject's own page now, by
 * the strip under its header (M50.2).
 */

const sameTab = (a: Nav, b: Nav): boolean => {
  if (a.tab !== b.tab) return false;
  if (a.tab === 'section' && b.tab === 'section') return a.folder === b.folder;
  if (a.tab === 'entity' && b.tab === 'entity') return a.key === b.key;
  return true;
};

function NavRow({
  icon,
  label,
  count,
  nav,
  active,
}: {
  icon: string;
  label: string;
  count?: number;
  nav: Nav;
  active: boolean;
}) {
  const navigate = useNavStore((s) => s.navigate);
  return (
    <button
      type="button"
      data-testid="knowledge-nav-row"
      data-tab={nav.tab}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigate({ kind: 'knowledge', nav })}
      className={rowClass(active)}
    >
      <Icon name={icon} size={15} color="var(--n-500)" />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      {count !== undefined && (
        <span className="ml-auto [font-family:var(--font-mono)] text-2xs text-n-400">{count}</span>
      )}
    </button>
  );
}

export function KnowledgeNav({
  nav,
  current = true,
}: {
  nav?: Nav;
  /**
   * Whether Knowledge owns the canvas right now (M42.2) — its page, or one of
   * its concepts open as a page, which lights that concept's folder (M52.3).
   * The nav renders on every surface since the groups nested — but lighting a
   * row while some OTHER surface is on screen would be a highlight naming a
   * view that is not there, so an un-current nav lights nothing.
   */
  current?: boolean;
}) {
  const concepts = useConcepts();
  const sections = useMemo(() => listSections(concepts), [concepts]);
  const queued = useMemo(() => reviewQueue(concepts).length, [concepts]);
  // Review holds the proposals agents queued as well as the concepts to
  // verify, so its count is both (M52.5) — "3" beside six decisions was the
  // row undercounting its own page. Cards that could not be read are left
  // out rather than counted as none.
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const pending = usePendingCards(vaultPath);
  const proposals = pending.kind === 'ready' ? pending.data.length : 0;
  const here: Nav = nav ?? { tab: 'all' };
  const is = (candidate: Nav) => current && sameTab(here, candidate);

  return (
    // M37.3: nested under the section row of the one nav column, which owns
    // the scrolling.
    <div className="pb-1">
      {sections.map((section) => (
        <NavRow
          key={section.folder}
          icon="folder"
          label={section.label}
          count={section.count}
          nav={{ tab: 'section', folder: section.folder }}
          active={is({ tab: 'section', folder: section.folder })}
        />
      ))}
      {/* The count lives on the row, not in the chrome: a destination may say
          how big it is, but nothing gets to count up at you from the chrome. */}
      <NavRow
        icon="shield-check"
        label="Review"
        count={queued + proposals}
        nav={{ tab: 'review' }}
        active={is({ tab: 'review' })}
      />
    </div>
  );
}
