import { agentRef, isAgentEntry, isPaused } from './agents';
import type { VaultEvent } from './events';
import { describeTrigger, firstMatch, parseTriggers, type Trigger } from './triggers';
import { sha256Hex } from '@/lib/sha256';
import type { Entry } from './types';

/**
 * Durable wakes, the renderer's half (M63.1).
 *
 * A change that matches an agent's trigger is offered to Rust as a WAKE,
 * admitted once into `runtime.db` (`src-tauri/src/runtime/wakes.rs`), and run
 * once. Before M63.1 an event run came from a one-slot list here: only the
 * first match fired, the next scan replaced the list, and a deferred event
 * run was never retried.
 *
 * Layer one only, as triggers have always been (M17.12): everything here is
 * answered from the scanned frontmatter, with no model consulted. A trigger's
 * `ask:` and `do:` ride the run's prompt.
 *
 * Pure: the keys, the offers and the verdicts are derived here and nowhere
 * else, and Rust checks only their shapes (D3: TS-only, so no twin).
 */

/** The most wakes one run answers: its own and nineteen more of the same
 * trigger, as `wakes::COALESCE_MAX` caps it in Rust. */
export const WAKE_COALESCE_MAX = 20;

/** Why a pending wake is cancelled as superseded, as Rust names it. */
export type CancelWhy = 'paused' | 'trigger_changed' | 'agent_gone' | 'page_gone';

/** A wake's cause as `run_agent` records it: the kind and its quoted values. */
export interface WakeCause {
  kind: string;
  subject?: string;
  detail?: string;
  due_at?: string;
}

/** One match offered for admission. */
export interface WakeOffer {
  /** `process:<handle>`, the agent the change wakes. */
  agent: string;
  /** The change's content key (`wakeKeyOf`). */
  wakeKey: string;
  /** The matched trigger's digest (`triggerDigest`). */
  trigger: string;
  cause: WakeCause;
  /** Bytes and event the backend uses to find the recorded writer. */
  path: string;
  hash: string;
  event: VaultEvent['kind'];
}

/** A wake waiting for its run, as `wakes_pending` reads it. */
export interface PendingWake {
  wakeId: string;
  agent: string;
  wakeKey: string;
  trigger: string;
  /** The cause Rust cleaned and stored at admission. */
  cause: WakeCause;
  author?: 'person' | 'run' | 'not_recorded' | null;
  authorActor?: string | null;
  parentRunId?: string | null;
  admittedAt: string;
  /** When a deferred wake may be tried again; null is now. */
  notBefore: string | null;
  /** The gate's reasons, comma-separated, from its last deferral. */
  deferred: string | null;
}

/** What one admission did. */
export interface AdmitReport {
  admitted: number;
  live: number;
  refused: { agent: string; reason: string }[];
}

/** One pending wake to cancel, and why. */
export interface WakeCancel {
  wakeId: string;
  why: CancelWhy;
}

/**
 * A change's content key: the SHA-256 of `v1`, its kind, path, old path,
 * previous hash and new hash, one per line. Two scans that see the same
 * change give the same key, so a relaunch or a second window admits it once;
 * the same bytes saved again after the wake ran are a new change only if
 * they are different bytes. Null while the new version's hash is not known
 * (M55.2): an unhashed version is never compared, so it never wakes.
 */
export function wakeKeyOf(event: VaultEvent): string | null {
  if (event.entry.hash === null) return null;
  const from = event.kind === 'moved' ? event.from : '';
  const before = event.kind === 'changed' ? (event.before.hash ?? '') : '';
  return sha256Hex(['v1', event.kind, event.path, from, before, event.entry.hash].join('\n'));
}

/** A trigger's digest: the first 16 hex of the SHA-256 of its key-sorted
 * JSON. A wake carries the digest of the trigger that matched, so an edited
 * or removed trigger cancels its wakes and a claim coalesces only its own. */
export function triggerDigest(trigger: Trigger): string {
  const sorted = Object.fromEntries(
    Object.keys(trigger)
      .sort()
      .map((key) => [key, trigger[key as keyof Trigger]]),
  );
  return sha256Hex(JSON.stringify(sorted)).slice(0, 16);
}

/** What a trigger says, as a run's cause detail and its log line: the
 * sentence `describeTrigger` reads, without its "When " and full stop. */
export function triggerWords(trigger: Trigger): string {
  return describeTrigger(trigger)
    .replace(/^When /, '')
    .replace(/\.$/, '');
}

/**
 * What one scan's events offer for admission: for every Agent record that is
 * not paused and has triggers, each event its first matching trigger fires
 * on, as an `event` cause whose subject is the changed path and whose detail
 * is the trigger's words.
 *
 * An agent is never woken by a change to ITSELF: editing its instructions,
 * or its own memory write at the end of a run, would otherwise be an event
 * it reacts to. An event whose bytes are not known yet offers nothing.
 */
export function wakeOffers(entries: readonly Entry[], events: readonly VaultEvent[]): WakeOffer[] {
  if (events.length === 0) return [];
  const offers: WakeOffer[] = [];
  for (const entry of entries) {
    if (!isAgentEntry(entry) || isPaused(entry)) continue;
    const triggers = parseTriggers(entry.properties.when);
    if (triggers.length === 0) continue;
    const agent = agentRef(entry).actor;
    for (const event of events) {
      if (event.path === entry.path) continue;
      const trigger = firstMatch(triggers, event);
      if (trigger === null) continue;
      const wakeKey = wakeKeyOf(event);
      if (wakeKey === null) continue;
      offers.push({
        agent,
        wakeKey,
        trigger: triggerDigest(trigger),
        cause: { kind: 'event', subject: event.path, detail: triggerWords(trigger) },
        path: event.path,
        hash: event.entry.hash!,
        event: event.kind,
      });
    }
  }
  return offers;
}

/**
 * Which pending wakes the vault no longer backs, each with the first why that
 * applies: no agent answers to its name (`agent_gone`), its record is paused
 * (`paused`), the trigger that matched is no longer on the record
 * (`trigger_changed`), or the page that changed is gone (`page_gone`).
 */
export function wakeVerdicts(
  entries: readonly Entry[],
  wakes: readonly PendingWake[],
): WakeCancel[] {
  const agents = new Map<string, Entry>();
  for (const entry of entries) {
    if (isAgentEntry(entry)) agents.set(agentRef(entry).actor, entry);
  }
  const paths = new Set(entries.map((e) => e.path));
  const verdicts: WakeCancel[] = [];
  for (const wake of wakes) {
    const agent = agents.get(wake.agent);
    const why: CancelWhy | null =
      agent === undefined
        ? 'agent_gone'
        : isPaused(agent)
          ? 'paused'
          : !parseTriggers(agent.properties.when).some((t) => triggerDigest(t) === wake.trigger)
            ? 'trigger_changed'
            : wake.cause.subject !== undefined && !paths.has(wake.cause.subject)
              ? 'page_gone'
              : null;
    if (why !== null) verdicts.push({ wakeId: wake.wakeId, why });
  }
  return verdicts;
}
