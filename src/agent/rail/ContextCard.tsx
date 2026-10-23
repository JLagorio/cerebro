import { Fragment, memo } from 'react';
import { ContextCategories } from '@/components/ai/Context';
import { RailSection } from '@/components/ai/Rail';
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ai/Trace';
import { Icon } from '@/components/ui/Icon';
import { StateMessage } from '@/components/ui/StateMessage';
import {
  RAIL_CONTEXT_WORDS,
  type RailContext,
  type RailContextServers,
} from '@/agent/elements/contextCard';
import './context-card.css';

/**
 * The rail's Context card (M92.14, §2): how full the conversation's
 * context is, the composer ring's figure on its heading line and in words
 * under it; then, where Claude Code's own breakdown came with the reading,
 * what the context holds row by row (`ContextCategories`), the model,
 * autocompact and the memory files, and each MCP server's part, folded as
 * Claude's card folds its tools. A deferred row reads "not loaded", never 0
 * or a dash. Last, when the reading was read, or, while a turn streams,
 * that it is the previous turn's.
 *
 * It reads nothing and polls nothing: the reading is the composer's own
 * pull (`useContextUse`), read into the card by `railContext`. Where it
 * shows less than the whole it says why (CV-05): no breakdown for this
 * turn, no window, nothing recorded yet, or a read that failed. While the
 * pull waits for a session's first answer, the card waits, drawing nothing.
 */

export interface ContextCardProps {
  /** The card, as `railContext` reads the composer's pull. */
  context: RailContext;
  /** Folded away with the rail (ConversationRail), hidden and inert: the
   *  card draws nothing new until the rail unfolds. */
  folded: boolean;
}

/** A folded card keeps what it drew; an unfolding one draws the latest. */
function stillWhileFolded(before: ContextCardProps, after: ContextCardProps): boolean {
  if (before.folded && after.folded) return true;
  return before.context === after.context && before.folded === after.folded;
}

export const ContextCard = memo(function ContextCard({ context }: ContextCardProps) {
  if (context.state === 'reading') return null;
  const { state } = context;
  return (
    <RailSection
      data-testid="rail-context"
      title={RAIL_CONTEXT_WORDS.title}
      icon="gauge"
      state={state}
      count={context.count ?? undefined}
      none={context.none}
    >
      {state === 'unavailable' && (
        <StateMessage compact state="unavailable" title={RAIL_CONTEXT_WORDS.unavailable} />
      )}
      {state === 'not-recorded' && (
        <StateMessage compact state="not-recorded" title={RAIL_CONTEXT_WORDS.notRecorded}>
          {RAIL_CONTEXT_WORDS.notRecordedDetail}
        </StateMessage>
      )}
      {context.figure !== null && (
        <p data-testid="rail-context-figure" className="cb-rail-context-figure">
          {context.figure}
        </p>
      )}
      {context.notes.map((note) => (
        <StateMessage key={note} compact state="partial" title={note} />
      ))}
      {context.categories !== null && (
        <ContextCategories
          testId="rail-context-categories"
          categories={context.categories}
          window={context.window}
          more={context.categoriesMore}
        />
      )}
      {context.facts.length > 0 && (
        <dl className="cb-rail-context-facts">
          {context.facts.map((fact) => (
            <Fragment key={fact.term}>
              <dt>{fact.term}</dt>
              <dd title={fact.value}>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {context.servers !== null && <Servers servers={context.servers} />}
      {context.freshness !== null && (
        <p data-testid="rail-context-freshness" className="cb-rail-context-freshness">
          {context.freshness.words},{' '}
          <time dateTime={context.freshness.at}>{context.freshness.time}</time>
        </p>
      )}
    </RailSection>
  );
}, stillWhileFolded);

/** Each MCP server's part, folded under one line that counts them; or that
 *  the breakdown said nothing of them. */
function Servers({ servers }: { servers: RailContextServers }) {
  if (servers.state === 'not-recorded') {
    return (
      <p data-testid="rail-context-servers" className="cb-rail-context-note">
        {RAIL_CONTEXT_WORDS.serversNotRecorded}
      </p>
    );
  }
  return (
    <TraceCollapsible data-testid="rail-context-servers" className="cb-rail-context-servers">
      <TraceCollapsibleTrigger tabIndex={0}>
        <TraceLine>
          <TraceIcon>
            <Icon name="server" size={16} />
          </TraceIcon>
          <TraceTitle>{RAIL_CONTEXT_WORDS.servers}</TraceTitle>
          <TraceDescription>{servers.rows.length}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>
        <dl className="cb-rail-context-server-list">
          {servers.rows.map((server) => (
            <div
              key={server.key}
              data-deferred={server.deferred || undefined}
              className="cb-rail-context-server"
            >
              <dt>
                <span className="cb-rail-context-server-name" title={server.name}>
                  {server.name}
                </span>
                <span className="cb-rail-context-server-tools">{server.tools}</span>
              </dt>
              <dd>{server.value}</dd>
            </div>
          ))}
        </dl>
        {servers.more !== null && <p className="cb-rail-context-note">{servers.more}</p>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
