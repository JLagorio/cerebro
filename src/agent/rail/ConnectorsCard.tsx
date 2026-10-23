import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { connectorFocus, type ConnectorStatusRead } from '@/agent/elements/connectorRow';
import {
  RAIL_CONNECTORS_WORDS,
  railConnectors,
  type ConnectorListRead,
  type RailConnectorLine,
} from '@/agent/elements/railConnectors';
import { openOutside } from '@/agent/rail/ConversationRail';
import type { RunReach } from '@/agent/types';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ai/Item';
import { RailSection } from '@/components/ai/Rail';
import { Icon } from '@/components/ui/Icon';
import { StateMessage } from '@/components/ui/StateMessage';
import type { ConnectorStatusRow } from '@/engine/connectors';
import { connectorStatus, readConnectors } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import './connectors-card.css';

/**
 * The rail's Connectors card (M92.9, §0 Q14, §2): the vault's connector
 * list in the words Settings says each entry in, joined with what the
 * conversation's latest run said it reaches (`railConnectors`). Read-only
 * (Q6): it switches, approves and signs in to nothing.
 *
 * It reads the list and the status (`readConnectors`, `connectorStatus`) as
 * it is shown, as the rail unfolds, and when a turn ends, since a run's
 * observations of its connectors land as it ends; never on a streamed word,
 * and nothing at all while it is folded away with the rail or while
 * Settings' Connectors switch is off. A read's answer lands only while it is
 * the latest, and an answer that says nothing new draws nothing.
 *
 * There is no Authenticate button: Cerebro holds no token. A connector that
 * needs a sign-in offers Sign in…, its secondary action (§1), which floats
 * the conversation first (`openOutside`), since the canvas hides Settings,
 * then opens Settings at its row, where the `claude /mcp` step is. Every
 * control is a tab stop of its own (WebKit), never an href (CV-16).
 */

export interface ConnectorsCardProps {
  /** The open vault, whose connector list the card reads. */
  vault: string | null;
  /** What the conversation's latest run said it reaches
   *  (`conversations.threadReach`); null when none has. */
  reach: RunReach | null;
  /** A turn runs: its end reads the list and the status again. */
  streaming: boolean;
  /** Folded away with the rail (ConversationRail), hidden and inert: the
   *  card reads nothing and draws nothing new until the rail unfolds. */
  folded: boolean;
}

/** A folded card keeps what it drew; an unfolding one draws the latest. */
function stillWhileFolded(before: ConnectorsCardProps, after: ConnectorsCardProps): boolean {
  if (before.folded && after.folded) return true;
  return (
    before.vault === after.vault &&
    before.reach === after.reach &&
    before.streaming === after.streaming &&
    before.folded === after.folded
  );
}

const NO_APPROVALS: readonly string[] = Object.freeze([]);

/** The two reads, as the card last answered them. */
interface ConnectorReads {
  list: ConnectorListRead;
  status: ConnectorStatusRead;
}

const READING: ConnectorReads = { list: { kind: 'loading' }, status: { kind: 'loading' } };

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function listOf(answer: PromiseSettledResult<string>): ConnectorListRead {
  return answer.status === 'fulfilled'
    ? { kind: 'ready', raw: answer.value }
    : { kind: 'unavailable', reason: reasonOf(answer.reason) };
}

function statusOf(answer: PromiseSettledResult<ConnectorStatusRow[]>): ConnectorStatusRead {
  return answer.status === 'fulfilled'
    ? { kind: 'ready', rows: answer.value }
    : { kind: 'unavailable', reason: reasonOf(answer.reason) };
}

/**
 * The vault's list and its connectors' status, read while `active` (the
 * card shown and Settings' switch on): as it starts, and again when a turn
 * ends. A read a newer one, a fold or the card's unmount overtook lands
 * nothing. The answers are kept by the vault they describe.
 */
function useConnectorReads(
  vault: string | null,
  active: boolean,
  streaming: boolean,
): ConnectorReads {
  const [held, setHeld] = useState<{ vault: string; reads: ConnectorReads } | null>(null);
  // Each turn's end, counted: it reads again.
  const [turn, setTurn] = useState({ streaming, ended: 0 });
  if (turn.streaming !== streaming) {
    setTurn({ streaming, ended: turn.ended + (turn.streaming ? 1 : 0) });
  }
  const latest = useRef(0);
  useEffect(() => {
    if (!active || vault === null) return;
    latest.current += 1;
    const asked = latest.current;
    void Promise.allSettled([readConnectors(vault), connectorStatus(vault)]).then(
      ([list, status]) => {
        if (latest.current !== asked) return;
        const reads: ConnectorReads = { list: listOf(list), status: statusOf(status) };
        setHeld((before) =>
          before !== null &&
          before.vault === vault &&
          JSON.stringify(before.reads) === JSON.stringify(reads)
            ? before
            : { vault, reads },
        );
      },
    );
    return () => {
      latest.current += 1;
    };
  }, [active, vault, turn.ended]);
  return held !== null && held.vault === vault ? held.reads : READING;
}

export const ConnectorsCard = memo(function ConnectorsCard({
  vault,
  reach,
  streaming,
  folded,
}: ConnectorsCardProps) {
  const enabled = useUiStore((s) => s.agentConnectors);
  const approvals = useUiStore((s) =>
    vault === null ? NO_APPROVALS : (s.stdioApprovals[vault] ?? NO_APPROVALS),
  );
  const setSettingsFocus = useUiStore((s) => s.setSettingsFocus);
  const navigate = useNavStore((s) => s.navigate);
  const { list, status } = useConnectorReads(vault, !folded && enabled, streaming);
  const view = useMemo(
    () => railConnectors({ vault, enabled, list, status, approvals, reach }),
    [vault, enabled, list, status, approvals, reach],
  );
  if (view.state === null) return null;
  const signIn = (name: string) =>
    openOutside(() => {
      setSettingsFocus(connectorFocus(name));
      navigate({ kind: 'settings' });
    });
  return (
    <RailSection
      data-testid="rail-connectors"
      title={RAIL_CONNECTORS_WORDS.title}
      icon="plug"
      state={view.state}
      count={view.count}
      none={view.none}
    >
      {view.state === 'unavailable' && (
        <StateMessage compact state="unavailable" title={RAIL_CONNECTORS_WORDS.unavailable}>
          {RAIL_CONNECTORS_WORDS.unavailableDetail(view.reason ?? '')}
        </StateMessage>
      )}
      {view.state === 'partial' && (
        <StateMessage
          compact
          state="partial"
          title={RAIL_CONNECTORS_WORDS.partial}
          testId="rail-connectors-partial"
        />
      )}
      {view.state === 'not-recorded' && (
        <StateMessage
          compact
          state="not-recorded"
          title={RAIL_CONNECTORS_WORDS.notRecorded}
          testId="rail-connectors-not-recorded"
        >
          {RAIL_CONNECTORS_WORDS.notRecordedDetail}
        </StateMessage>
      )}
      {view.lines.length > 0 && (
        <ItemGroup className="cb-rail-connectors">
          {view.lines.map((line) => (
            <ConnectorItem key={line.name} line={line} onSignIn={signIn} />
          ))}
        </ItemGroup>
      )}
      {view.more !== null && (
        <p data-testid="rail-connectors-more" className="cb-rail-connectors-note">
          {view.more}
        </p>
      )}
      {view.inherited && (
        <p data-testid="rail-connectors-inherited" className="cb-rail-connectors-note">
          {RAIL_CONNECTORS_WORDS.inherited}
        </p>
      )}
      {view.mail && (
        <p data-testid="rail-connectors-mail" className="cb-rail-connectors-note">
          {RAIL_CONNECTORS_WORDS.mail}
        </p>
      )}
    </RailSection>
  );
}, stillWhileFolded);

/** One connector: its name, Settings' words for it, what the conversation's
 *  latest run did with it, and Sign in… where it needs one. */
function ConnectorItem({
  line,
  onSignIn,
}: {
  line: RailConnectorLine;
  onSignIn: (name: string) => void;
}) {
  const label = RAIL_CONNECTORS_WORDS.signInLabel(line.name);
  return (
    <Item
      size="xs"
      data-testid="rail-connector"
      data-name={line.name}
      data-status={line.status}
      data-run={line.run ?? undefined}
      className="cb-rail-connector"
    >
      <ItemMedia variant="icon">
        <Icon name={line.run === 'loaded' ? 'plug' : 'unplug'} size={16} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="cb-rail-connector-name">{line.name}</ItemTitle>
        {line.words !== null && (
          <p
            data-testid="rail-connector-status"
            data-quiet={line.quiet || undefined}
            className="cb-rail-connector-status"
          >
            {line.words}
          </p>
        )}
        {line.facts !== null && (
          <ItemDescription data-testid="rail-connector-run" title={line.facts}>
            {line.facts}
          </ItemDescription>
        )}
      </ItemContent>
      {line.signIn && (
        <ItemActions>
          <button
            type="button"
            // WebKit leaves a native button without one out of the Tab order.
            tabIndex={0}
            data-testid="rail-connector-sign-in"
            aria-label={label}
            title={label}
            className="cb-rail-connector-sign-in"
            onClick={() => onSignIn(line.name)}
          >
            {RAIL_CONNECTORS_WORDS.signIn}
          </button>
        </ItemActions>
      )}
    </Item>
  );
}
