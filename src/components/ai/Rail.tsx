import { useId, type ComponentProps, type ReactNode, type Ref } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Collapsible, CollapsibleContent, type CollapsibleOpenProps } from './Collapsible';
import {
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './Trace';
import './rail.css';

/**
 * A rail of cards beside a conversation (M92.1): the side rail Claude's and
 * ChatGPT's full-screen views keep, as a labelled region under its own
 * heading, its cards in order. Presentation only (CV-64): where it stands,
 * docked or a drawer, and how wide, are its host's, and each card is handed
 * what it says.
 */

export type RailProps = Omit<ComponentProps<'section'>, 'title'> & {
  /** The rail's name: its heading, and so the region's. */
  title: ReactNode;
  /** The heading, which a host focuses as the rail opens (it takes focus
   *  without being a tab stop). */
  headingRef?: Ref<HTMLHeadingElement>;
};

export function Rail({ title, headingRef, className, children, ...props }: RailProps) {
  const headingId = useId();
  return (
    <section
      data-slot="rail"
      aria-labelledby={headingId}
      {...props}
      className={['cb-ai-rail', className].filter(Boolean).join(' ')}
    >
      <h2 ref={headingRef} id={headingId} tabIndex={-1} className="cb-ai-rail-heading">
        {title}
      </h2>
      <div data-slot="rail-cards" className="cb-ai-rail-cards">
        {children}
      </div>
    </section>
  );
}

/**
 * A card's state (CV-05, CV-44): what it read, that it read nothing, that
 * nothing was recorded, that some of it could not be read, or that the read
 * failed. Only `empty` is quiet.
 */
export type RailSectionState = 'ready' | 'empty' | 'not-recorded' | 'partial' | 'unavailable';

export type RailSectionProps = Omit<ComponentProps<'section'>, 'title'> &
  CollapsibleOpenProps & {
    /** The card's name, which its heading line leads with. */
    title: ReactNode;
    /** What the heading line says after the name: a count, or where things
     *  stand ("3 of 5 done", "2 running · 3 done"). */
    count?: ReactNode;
    icon?: string;
    state: RailSectionState;
    /** What an empty card says after its name. */
    none?: ReactNode;
  };

/**
 * One card. Empty, it is one heading line ending in a muted "None", and
 * nothing opens (Q7: an empty lane stays quiet). Every other state keeps its
 * body under a heading line that folds it, open to start, and kept in the
 * document while folded so what is inside keeps its own state. The heading
 * line is the card's group name; its fold is a tab stop of its own, since
 * WebKit leaves a native button without one out of the Tab order.
 */
export function RailSection({
  title,
  count,
  icon,
  state,
  none = 'None',
  open,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: RailSectionProps) {
  const titleId = useId();
  const line = (
    <TraceLine>
      {icon !== undefined && (
        <TraceIcon>
          <Icon name={icon} size={16} />
        </TraceIcon>
      )}
      <TraceTitle id={titleId} className="cb-ai-rail-section-title">
        {title}
      </TraceTitle>
      {state === 'empty' ? (
        <TraceDescription className="cb-ai-rail-section-none">{none}</TraceDescription>
      ) : (
        count !== undefined && count !== null && <TraceDescription>{count}</TraceDescription>
      )}
    </TraceLine>
  );
  return (
    <section
      data-slot="rail-section"
      role="group"
      aria-labelledby={titleId}
      {...props}
      data-state={state}
      className={['cb-ai-rail-section', className].filter(Boolean).join(' ')}
    >
      {state === 'empty' ? (
        <h3 className="cb-ai-rail-section-heading">{line}</h3>
      ) : (
        <Collapsible open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
          <h3 className="cb-ai-rail-section-heading">
            <TraceCollapsibleTrigger tabIndex={0} className="cb-ai-rail-section-trigger">
              {line}
            </TraceCollapsibleTrigger>
          </h3>
          <CollapsibleContent keepMounted className="cb-ai-rail-section-body">
            {children}
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
