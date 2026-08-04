import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { buildDossier, isEmptyDossier, type Unsettled } from '@/engine/dossier';
import { listConcepts, type Concept } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { TrustChip } from '@/knowledge/TrustChip';
import { distillPrompt } from '@/lib/prompts';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useOpenPath } from '@/app/useOpenPath';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Everything the base knows about one entity (M8.9).
 *
 * This replaces the flat "what the assistant knows" list, which could say a
 * count and nothing else. Four things are shown and each earns its place:
 * what is currently believed, what disagrees or has gone stale, what was read
 * to get here, and what has been retired. A summary that showed only the first
 * would be the confident-and-wrong kind, which is how people stop trusting a
 * system like this.
 *
 * Still passive. It sits under the page and waits to be scrolled to; the only
 * active thing on it is a button, pressed by a person.
 */

const LABEL = 'text-2xs font-semibold uppercase tracking-[0.06em] text-n-500';

function ConceptRow({
  concept,
  retired = false,
  onOpen,
}: {
  concept: Concept;
  retired?: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="dossier-concept"
      data-path={concept.entry.path}
      data-retired={retired ? 'true' : 'false'}
      onClick={() => onOpen(concept.entry.path)}
      className="flex w-full min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
    >
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm font-medium ${
            retired ? 'text-n-400 line-through' : 'text-n-800'
          }`}
        >
          {concept.title}
        </span>
        {concept.description !== null && !retired && (
          <span className="block truncate text-xs text-n-500">{concept.description}</span>
        )}
      </span>
      {!retired && <TrustChip tier={concept.trust} size="sm" />}
    </button>
  );
}

function UnsettledRow({ item, onOpen }: { item: Unsettled; onOpen: (path: string) => void }) {
  return (
    <li className="flex items-start gap-2 px-2 py-1">
      <span className="mt-[3px] flex-none text-warn-600">
        <Icon
          name={item.reason === 'contradicts' ? 'git-compare-arrows' : 'clock-alert'}
          size={12}
        />
      </span>
      <span className="min-w-0 flex-1 text-xs leading-[17px] text-n-700">
        {item.reason === 'contradicts' ? (
          <>
            <button
              type="button"
              data-testid="dossier-unsettled-link"
              onClick={() => onOpen(item.concept.entry.path)}
              className="border-0 bg-transparent p-0 text-xs text-cortex-600 hover:underline"
            >
              {item.concept.title}
            </button>{' '}
            disagrees with{' '}
            <button
              type="button"
              data-testid="dossier-unsettled-link"
              onClick={() => item.other !== null && onOpen(item.other.entry.path)}
              className="border-0 bg-transparent p-0 text-xs text-cortex-600 hover:underline"
            >
              {item.other?.title ?? 'another concept'}
            </button>
            . Neither has won.
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid="dossier-unsettled-link"
              onClick={() => onOpen(item.concept.entry.path)}
              className="border-0 bg-transparent p-0 text-xs text-cortex-600 hover:underline"
            >
              {item.concept.title}
            </button>{' '}
            was due a recheck on {item.concept.staleAfter}.
          </>
        )}
      </span>
    </li>
  );
}

export function EntityDossier({
  entry,
  variant = 'section',
}: {
  entry: Entry;
  /** 'section' sits in a page; 'panel' is the narrower side-panel variant. */
  variant?: 'section' | 'panel';
}) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const setPendingPrompt = useUiStore((s) => s.setAgentPendingPrompt);

  const today = todayIso();
  const dossier = useMemo(
    () => buildDossier(entry.path, listConcepts(entries, today), entries),
    [entries, entry.path, today],
  );

  const closeDetail = useUiStore((s) => s.closeDetail);
  // Following a concept leaves the record for the knowledge page; a panel left
  // open would sit beside it showing the record you just left — and squeeze
  // the concept body to nothing at laptop widths (M14.2).
  const openConcept = (path: string) => {
    closeDetail();
    navigate({ kind: 'knowledge', nav: { tab: 'all' }, path });
  };

  const ask = () => {
    setAiPanelOpen(true);
    setPendingPrompt(distillPrompt(entry.path, entry.title));
  };

  const since = relativeDay(dossier.firstLearned, today);
  const latest = relativeDay(dossier.lastLearned, today);

  return (
    <section
      data-testid="entity-dossier"
      data-count={dossier.current.length}
      className={variant === 'panel' ? '' : 'mt-8 border-t border-n-100 pt-5'}
    >
      <div className="flex items-center gap-2">
        <Icon name="brain" size={14} color="var(--cortex-500)" />
        <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-n-500">
          What the assistant knows
        </h3>
        {/* Growth, stated once, in words. The alternative is a number that
            ticks up somewhere permanent, which is the pattern these surfaces
            are barred from. */}
        {dossier.current.length > 0 && since !== null && (
          <span className="text-2xs text-n-400">
            {dossier.current.length} {dossier.current.length === 1 ? 'thing' : 'things'}, first
            learned {since}
            {latest !== null && latest !== since ? `, most recently ${latest}` : ''}
          </span>
        )}
      </div>

      {isEmptyDossier(dossier) ? (
        <p className="m-0 mt-2 text-sm leading-[18px] text-n-500">Nothing yet about this.</p>
      ) : (
        <>
          <ul className="m-0 mt-2 flex list-none flex-col gap-px p-0">
            {dossier.current.map((concept) => (
              <li key={concept.entry.path}>
                <ConceptRow concept={concept} onOpen={openConcept} />
              </li>
            ))}
          </ul>

          {dossier.unsettled.length > 0 && (
            <div className="mt-4" data-testid="dossier-unsettled">
              <div className={LABEL}>Unsettled</div>
              <ul className="m-0 mt-1 flex list-none flex-col p-0">
                {dossier.unsettled.map((item) => (
                  <UnsettledRow
                    key={`${item.reason}:${item.concept.entry.path}`}
                    item={item}
                    onOpen={openConcept}
                  />
                ))}
              </ul>
            </div>
          )}

          {dossier.readFrom.length > 0 && (
            <div className="mt-4" data-testid="dossier-sources">
              <div className={LABEL}>Read from</div>
              <ul className="m-0 mt-1 flex list-none flex-col gap-px p-0">
                {dossier.readFrom.map((source) => (
                  <li key={source.resource}>
                    <button
                      type="button"
                      data-testid="dossier-source"
                      data-path={source.resource}
                      onClick={() => openPath(source.resource)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left hover:bg-n-50"
                    >
                      <Icon name="file-text" size={12} color="var(--n-400)" />
                      <span className="min-w-0 flex-1 truncate text-xs text-n-700">
                        {source.title ?? source.resource}
                      </span>
                      {source.citedBy > 1 && (
                        <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-400">
                          ×{source.citedBy}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {dossier.retired.length > 0 && (
            <div className="mt-4" data-testid="dossier-retired">
              <div className={LABEL}>No longer believed</div>
              <ul className="m-0 mt-1 flex list-none flex-col gap-px p-0">
                {dossier.retired.map((concept) => (
                  <li key={concept.entry.path}>
                    <ConceptRow concept={concept} retired onOpen={openConcept} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="mt-3">
        <Button variant="secondary" size="sm" icon="sparkles" onClick={ask}>
          Learn from this page
        </Button>
      </div>
    </section>
  );
}
