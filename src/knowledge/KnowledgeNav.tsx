import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { rowClass, SECTION_LABEL } from '@/app/sidebarChrome';
import { listConcepts, listSections, listSubjects, needsReview } from '@/engine/okf';
import { typeStyle } from '@/engine/typeCatalog';
import type { KnowledgeNav as Nav } from '@/engine/types';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * The Knowledge sidebar (M8.1).
 *
 * Knowledge used to borrow Home's sidebar — Views and Types — which describe a
 * corpus with a different author and different rules, so the page had to grow
 * a second nav column inside its own canvas to have anywhere to put its real
 * navigation. This is that navigation, in the place navigation goes.
 *
 * Its axes are the bundle's own: the sections it is filed under, the entities
 * its concepts are ABOUT, and the log of what changed. Only the entity axis is
 * new — and it is the one that makes the bundle part of the vault rather than
 * a corpus sitting beside it.
 *
 * M33a.2 gave it a second group. What the base HOLDS and what it knows about
 * ITSELF were two rail buttons describing one subject; they are two groups of
 * one nav now, and the Status hub's own five-row nav is gone with it.
 */

const sameTab = (a: Nav, b: Nav): boolean => {
  if (a.tab !== b.tab) return false;
  if (a.tab === 'section' && b.tab === 'section') return a.folder === b.folder;
  if (a.tab === 'entity' && b.tab === 'entity') return a.key === b.key;
  // `runs` deliberately compares equal whichever run is deep-linked: opening
  // one run does not move you to a different row.
  return true;
};

function NavRow({
  icon,
  label,
  count,
  color,
  nav,
  active,
}: {
  icon: string;
  label: string;
  count?: number;
  color?: string | null;
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
      <Icon name={icon} size={15} color={color ?? 'var(--n-500)'} />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      {count !== undefined && (
        <span className="ml-auto [font-family:var(--font-mono)] text-2xs text-n-400">{count}</span>
      )}
    </button>
  );
}

export function KnowledgeNav({ nav }: { nav: Nav }) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const today = todayIso();

  const concepts = useMemo(() => listConcepts(entries, today), [entries, today]);
  const sections = useMemo(() => listSections(concepts), [concepts]);
  const subjects = useMemo(() => listSubjects(concepts, entries), [concepts, entries]);
  const reviewCount = useMemo(() => concepts.filter(needsReview).length, [concepts]);

  const is = (candidate: Nav) => sameTab(nav, candidate);

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-4">
      <NavRow
        icon="brain"
        label="All concepts"
        count={concepts.length}
        nav={{ tab: 'all' }}
        active={is({ tab: 'all' })}
      />
      {/* The count lives on the row, not on the Rail: a destination may say
          how big it is, but nothing gets to count up at you from the chrome. */}
      <NavRow
        icon="shield-check"
        label="Needs review"
        count={reviewCount}
        nav={{ tab: 'review' }}
        active={is({ tab: 'review' })}
      />
      <NavRow icon="history" label="Update log" nav={{ tab: 'log' }} active={is({ tab: 'log' })} />

      {sections.length > 0 && (
        <>
          <div className={SECTION_LABEL}>Sections</div>
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
        </>
      )}

      {subjects.length > 0 && (
        <>
          <div className={SECTION_LABEL}>About</div>
          {subjects.map((subject) => {
            // A dangling anchor keeps its place in the list — it names an
            // entity that does not exist yet, which is worth seeing, not
            // hiding (OKF §6.1).
            const style = typeStyle(subject.entry?.type ?? null, schema);
            return (
              <NavRow
                key={subject.key}
                icon={subject.entry === null ? 'link-2-off' : style.icon}
                color={subject.entry === null ? 'var(--n-300)' : style.color}
                label={subject.label}
                count={subject.concepts.length}
                nav={{ tab: 'entity', key: subject.key }}
                active={is({ tab: 'entity', key: subject.key })}
              />
            );
          })}
        </>
      )}

      {/* M33a.2 — what the base knows about ITSELF, folded in from the Status
          rail button. Two destinations described one subject: a bundle that
          cannot say what it is unsure of is not a knowledge base, it is a
          folder.

          No counts on any of these rows, and none on the Knowledge rail
          button either. A badge here would be the chrome telling somebody
          their understanding is broken before they have asked it anything —
          the rule that kept a review count off Knowledge (M8.1) and a commit
          count off History (M9.4), now carried by the row that inherited the
          responsibility. */}
      <div className={SECTION_LABEL}>What it knows about itself</div>
      <NavRow
        icon="activity"
        label="What changed"
        nav={{ tab: 'changed' }}
        active={is({ tab: 'changed' })}
      />
      <NavRow
        icon="git-compare"
        label="What's contested"
        nav={{ tab: 'contested' }}
        active={is({ tab: 'contested' })}
      />
      {/* "Waiting on you", not "Needs review". The row three above holds
          CONCEPTS a human has not verified; this one holds PROPOSALS awaiting
          approve or reject. Two unrelated queues under one string is a nav
          that lies about where a click lands. */}
      <NavRow
        icon="gavel"
        label="Waiting on you"
        nav={{ tab: 'waiting' }}
        active={is({ tab: 'waiting' })}
      />
      <NavRow
        icon="gauge"
        label="Background"
        nav={{ tab: 'background' }}
        active={is({ tab: 'background' })}
      />
      <NavRow icon="bot" label="Agent work" nav={{ tab: 'runs' }} active={is({ tab: 'runs' })} />
      <NavRow
        icon="scan-eye"
        label="Deferral gates"
        nav={{ tab: 'gates' }}
        active={is({ tab: 'gates' })}
      />
    </div>
  );
}
