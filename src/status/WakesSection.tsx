import { StateMessage } from '@/components/ui/StateMessage';
import { useEffect, useMemo, useState } from 'react';
import { wakeSections, wakeState } from '@/agent/elements/runsQueue';
import { Queue, QueueItem, QueueList, QueueSection } from '@/components/ai/Queue';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { actorLabel } from '@/engine/authors';
import { writerWords } from '@/engine/attribution';
import { recordIdentity } from '@/engine/identity';
import { TRIGGER_COOLDOWN_MS } from '@/engine/jobs';
import { instantText } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetWake } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

type Read =
  { key: string; kind: 'ready'; wakes: FleetWake[] } | { key: string; kind: 'unavailable' };

/**
 * Waiting to wake (M63.1b): what is waiting to wake the vault's agents, and
 * what was skipped or expired this week, read from runtime.db's
 * `agent_wakes` through `fleet_wakes`.
 *
 * Two hosts: the Agents lobby (every agent) and an agent page's Runs tab
 * (`actor`, that agent alone). It reads again whenever the job runner's own
 * read of the pending wakes lands (`wakesRevision`), so a wake admitted,
 * started, deferred or cancelled shows within a tick.
 *
 * A pending row says how long it has waited and why it still waits: a
 * budget deferral with its time to try again, or the event cooldown, which
 * is recomputed here from `triggerRuns` the way `engine/jobs.ts` reads it.
 * Every other row says Rust's words (`wakes::words`). A read that fails says
 * so, never that nothing is waiting (CV-05).
 *
 * The list is a queue (M91.14): what still waits, then what was skipped or
 * expired, each wake an item whose state its icon draws and a screen reader
 * hears before its agent's name, in the order the read gave them.
 */
export function WakesSection({ vaultPath, actor }: { vaultPath: string | null; actor?: string }) {
  const entries = useVaultStore((s) => s.entries);
  const revision = useUiStore((s) => s.wakesRevision);
  const triggerRuns = useUiStore((s) => s.triggerRuns);
  const navigate = useNavStore((s) => s.navigate);
  const key = `${vaultPath ?? ''}\n${actor ?? ''}`;
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    if (vaultPath === null) return;
    let live = true;
    void ipc.fleetWakes(vaultPath, actor).then(
      (wakes) => live && setRead({ key, kind: 'ready', wakes }),
      () => live && setRead({ key, kind: 'unavailable' }),
    );
    return () => {
      live = false;
    };
  }, [vaultPath, actor, key, revision]);

  // The agent each wake names, for its cooldown clock (its bare identity).
  const identities = useMemo(() => {
    const byActor = new Map<string, string>();
    for (const entry of entries) {
      if (isAgentEntry(entry)) byActor.set(agentRef(entry).actor, recordIdentity(entry));
    }
    return byActor;
  }, [entries]);
  const pages = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  // A read for another vault or agent cannot describe this one.
  if (vaultPath === null) return null;
  if (read === null || read.key !== key)
    return <StateMessage state="loading" title="Reading waiting work…" compact />;

  const header = (
    <div className="mb-1.5">
      <h2 className="m-0 text-section-title font-semibold text-n-800">Waiting to wake</h2>
      <p className="m-0 text-xs leading-[17px] text-(--text-meta)">
        Changes that arrive while an agent waits wake it once, together — up to 20 in one run. Each
        assignment wakes its own run.
      </p>
    </div>
  );

  if (read.kind === 'unavailable') {
    // NOT the empty line: "nothing is waiting" and "could not tell what is
    // waiting" are opposite sentences.
    return (
      <div data-testid="agent-wakes">
        {header}
        <p data-testid="agent-wakes-unavailable" className="m-0 text-sm text-(--text-meta)">
          Couldn't read what is waiting to wake your agents.
        </p>
      </div>
    );
  }

  if (read.wakes.length === 0) {
    return (
      <div data-testid="agent-wakes">
        {header}
        <p data-testid="agent-wakes-empty" className="m-0 text-sm text-(--text-meta)">
          {actor === undefined
            ? 'Nothing is waiting to wake an agent.'
            : 'Nothing is waiting to wake it.'}
        </p>
      </div>
    );
  }

  const now = Date.now();
  const vaultClock = triggerRuns[vaultPath] ?? {};

  /** Why a pending wake still waits, or null when it is due now. */
  const stillWaits = (wake: FleetWake): string | null => {
    if (wake.notBefore !== null && Date.parse(wake.notBefore) > now) {
      if (wake.deferred === null)
        return `its check couldn't answer · tries again ${instantText(wake.notBefore)}`;
      const reasons = wake.deferred.split(',').join(', ');
      return `deferred: ${reasons} · tries again ${instantText(wake.notBefore)}`;
    }
    if (wake.cause?.kind === 'assigned' && (wake.author === 'person' || wake.author === 'run'))
      return null;
    const identity = identities.get(wake.agent);
    const last = identity === undefined ? undefined : vaultClock[identity];
    if (last !== undefined) {
      const until = Date.parse(last) + TRIGGER_COOLDOWN_MS;
      if (until > now) return `cooling down until ${instantText(new Date(until).toISOString())}`;
    }
    return null;
  };

  /** One wake, as a queue item: its agent, and under it the page it is
   *  about, why, who wrote the change and where it stands. */
  const item = (wake: FleetWake) => {
    const who = actorLabel(wake.agent, entries);
    const state = wakeState(wake.state);
    const subject = wake.cause?.subject ?? null;
    const page = subject === null ? undefined : pages.get(subject);
    const waits = wake.state === 'pending' ? stillWaits(wake) : null;
    return (
      <QueueItem
        key={wake.wakeId}
        data-testid="agent-wake"
        data-state={wake.state}
        statusText={state.statusText}
        icon={state.icon}
        title={
          <span className="text-n-800" title={who.raw ?? undefined}>
            {who.text}
          </span>
        }
      >
        <span className="flex flex-wrap items-baseline gap-x-2">
          {subject !== null &&
            (page !== undefined ? (
              <button
                type="button"
                data-testid="agent-wake-subject"
                title={subject}
                onClick={() => navigate({ kind: 'doc', path: subject })}
                className="min-w-0 truncate border-0 bg-transparent p-0 text-left text-metadata text-cortex-600 hover:underline"
              >
                {page.title}
              </button>
            ) : (
              // The page is gone: there is nothing to open.
              <span
                data-testid="agent-wake-subject"
                data-gone="true"
                className="min-w-0 truncate text-(--text-meta)"
              >
                {subject}
              </span>
            ))}
          {wake.cause?.kind === 'assigned' && (
            <span data-testid="agent-wake-cause" className="text-metadata text-(--text-meta)">
              {wake.cause.why}
              {wake.cause.detail === null ? '' : ` (${wake.cause.detail})`}
            </span>
          )}
          <span data-testid="agent-wake-author" className="text-metadata text-(--text-meta)">
            {(wake.author === 'person' || wake.author === 'run') && wake.authorActor != null
              ? `by ${writerWords(wake.authorActor, entries)}`
              : 'author not recorded'}
          </span>
          <span data-testid="agent-wake-words" className="text-metadata text-(--text-meta)">
            {wake.state === 'pending' ? (
              <span title={wake.admittedAt}>waiting since {instantText(wake.admittedAt)}</span>
            ) : (
              <span title={wake.finishedAt ?? undefined}>{wake.words}</span>
            )}
          </span>
          {waits !== null && (
            <span data-testid="agent-wake-waits" className="text-metadata text-(--text-meta)">
              {waits}
            </span>
          )}
        </span>
        {wake.state === 'skipped' && wake.note != null && (
          <span data-testid="agent-wake-check" className="block text-metadata text-(--text-meta)">
            “{wake.note.question}” — {wake.note.reason}
          </span>
        )}
      </QueueItem>
    );
  };
  const { waiting, ended } = wakeSections(read.wakes);

  return (
    <div data-testid="agent-wakes">
      {header}
      <Queue>
        {waiting.length > 0 && (
          <QueueSection
            data-group="waiting"
            collapsible={false}
            headingLevel={3}
            label="waiting"
            count={waiting.length}
            icon="clock"
          >
            <QueueList>{waiting.map(item)}</QueueList>
          </QueueSection>
        )}
        {ended.length > 0 && (
          <QueueSection
            data-group="ended"
            collapsible={false}
            headingLevel={3}
            label="skipped or expired this week"
            count={ended.length}
            icon="history"
          >
            <QueueList>{ended.map(item)}</QueueList>
          </QueueSection>
        )}
      </Queue>
    </div>
  );
}
