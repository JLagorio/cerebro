// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { cloneElement, type ReactElement, type ReactNode, type Ref } from 'react';
import { HoverCard, type HoverCardTriggerProps } from '@/components/ui/HoverCard';
import { Icon } from '@/components/ui/Icon';
import { httpUrl } from '@/engine/ai/sources';
import type { SourceRef } from '@/engine/ai/types';
import { useMergedRefs } from './mergeRefs';
import { SOURCES_WORDS, sourceHost, sourceName } from './Sources';
import { plural, vaultPathOf, type VaultPathProps } from './StepLine';
import './trace-results.css';

/**
 * A source in the sentence that opens on hover (M91.9, shadcn's Inline
 * Citation). shadcn makes the citation a button whose card holds the only
 * link; a card that opens on hover is no place for the one way in, since a
 * keyboard or a screen reader cannot reach it. So the trigger here is the
 * caller's own — the reply's link, a wikilink button, a citation's number —
 * with its name and role unchanged, and it is what opens the source; the
 * card is an extra. It opens on hover and on keyboard focus, and while it is
 * open it describes its trigger.
 *
 * The card names each source and where it is: a web page links out in a new
 * tab, and says so; a vault page is a button that opens it in the app,
 * through the caller, never an href (CV-16).
 */

/** A source as a citation shows it: what Sources lists, and what it says. */
export type CitationSource = SourceRef & {
  /** A line on what the source says: a footnote's definition, a summary. */
  description?: string;
};

/** The card's name: "Source", or "3 sources". */
export function citationLabel(sources: readonly CitationSource[]): string {
  return sources.length === 1 ? 'Source' : plural(sources.length, 'source', 'sources');
}

export type InlineCitationSourceProps = VaultPathProps & {
  source: CitationSource;
};

/** One source in the card: its name, what it says, and where it is. */
export function InlineCitationSource({
  source,
  onOpenPath,
  isVaultPath,
}: InlineCitationSourceProps) {
  const url = source.kind === 'url' ? httpUrl(source.url) : null;
  const path =
    source.kind === 'vault' && onOpenPath !== undefined
      ? vaultPathOf(source.path, isVaultPath)
      : null;
  const description = source.description?.trim() ?? '';
  // An untitled source is named by its address, so the address is said once:
  // as the link or button when it has one, else as the name.
  const titled = (source.title?.trim() ?? '') !== '';
  const reachable = url !== null || path !== null;
  let where: ReactNode;
  if (url !== null) {
    where = (
      <a href={url} target="_blank" rel="noreferrer noopener" className="cb-ai-citation-link">
        {sourceHost(url) ?? url}
        <span className="sr-only">{SOURCES_WORDS.newTab}</span>
        <Icon name="arrow-up-right" size={12} />
      </a>
    );
  } else if (path !== null && onOpenPath !== undefined) {
    where = (
      <button type="button" className="cb-ai-citation-link" onClick={() => onOpenPath(path)}>
        <span className="sr-only">{SOURCES_WORDS.open}</span>
        {path}
      </button>
    );
  } else {
    where = (
      <span className="cb-ai-citation-where">
        {source.kind === 'url' ? source.url : source.path}
      </span>
    );
  }
  return (
    <div
      data-slot="inline-citation-source"
      data-kind={source.kind}
      className="cb-ai-citation-source"
    >
      {(titled || !reachable) && <p className="cb-ai-citation-title">{sourceName(source)}</p>}
      {description !== '' && <p className="cb-ai-citation-description">{description}</p>}
      {(titled || reachable) && where}
    </div>
  );
}

/** What the caller's trigger brings of its own: a ref, and a description
 *  the card's is added to. */
interface TriggerProps {
  ref?: Ref<HTMLElement>;
  'aria-describedby'?: string;
}

/** The caller's trigger, handed the card's ref and description beside its
 *  own. */
function CitationTrigger({
  trigger,
  children,
}: {
  trigger: HoverCardTriggerProps;
  children: ReactElement<TriggerProps>;
}) {
  const own = children.props;
  const ref = useMergedRefs<HTMLElement>(trigger.ref, own.ref);
  const describedBy =
    [own['aria-describedby'], trigger.describedBy].filter(Boolean).join(' ') || undefined;
  return cloneElement(children, { ref, 'aria-describedby': describedBy });
}

export type InlineCitationProps = VaultPathProps & {
  /** What the cited words rest on: one source, or several. */
  sources: readonly CitationSource[];
  /**
   * The trigger: the caller's own focusable element — a link, a button — kept
   * as it is, or a function that draws one from the card's ref and
   * description (HoverCard's render prop).
   */
  children: ReactElement<TriggerProps> | ((trigger: HoverCardTriggerProps) => ReactNode);
  /** The card's name; left out, "Source" or "3 sources". */
  label?: string;
  /** One card per group is open at a time. */
  group?: string;
  openDelay?: number;
  closeDelay?: number;
  disabled?: boolean;
};

/** The trigger, and the card it opens. With no sources there is no card. */
export function InlineCitation({
  sources,
  children,
  label,
  group,
  openDelay,
  closeDelay,
  disabled = false,
  onOpenPath,
  isVaultPath,
}: InlineCitationProps) {
  return (
    <HoverCard
      label={label ?? citationLabel(sources)}
      group={group}
      openDelay={openDelay}
      closeDelay={closeDelay}
      disabled={disabled || sources.length === 0}
      content={({ close }) => (
        <div data-slot="inline-citation-card" className="cb-ai-citation-card">
          {sources.map((source, index) => (
            <InlineCitationSource
              key={`${index}:${source.kind === 'url' ? source.url : source.path}`}
              source={source}
              isVaultPath={isVaultPath}
              onOpenPath={
                onOpenPath === undefined
                  ? undefined
                  : (path) => {
                      close();
                      onOpenPath(path);
                    }
              }
            />
          ))}
        </div>
      )}
    >
      {(trigger) =>
        typeof children === 'function' ? (
          children(trigger)
        ) : (
          <CitationTrigger trigger={trigger}>{children}</CitationTrigger>
        )
      }
    </HoverCard>
  );
}
