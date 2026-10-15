/** Agent links wake only on observed gains. Inheritance belongs to five human
 * doors: patchFrontmatter, createItem, bulkSetField, addExistingToHost and
 * writeReciprocal. Batch replay, undo, imports and agent writes add nothing. */
import { AGENT_TYPE, agentRef, isAgentEntry, isPaused } from './agents';
import type { VaultEvent } from './events';
import { parseTriggers, type Trigger } from './triggers';
import type { Entry, FieldDef, Schema } from './types';
import { triggerDigest, type PendingWake, type WakeOffer } from './wakes';
import { formatWikilink, linkTargetOf, parseWikilinks, resolveTarget } from './wikilink';
import { filingFields } from './filing';
import type { BatchOp } from './batch';
import { sha256Hex } from '@/lib/sha256';

export const isAgentField = (field: FieldDef): boolean =>
  field.kind === 'relation' && field.from === undefined && field.target === AGENT_TYPE;

export function agentFieldsOf(typeName: string | null, schema: Schema): FieldDef[] {
  return (typeName === null ? [] : (schema.types.get(typeName)?.fields ?? [])).filter(isAgentField);
}

export function agentFieldNames(schema: Schema): { field: string; type: string; label: string }[] {
  return [...schema.types].flatMap(([type, definition]) =>
    definition.fields
      .filter(isAgentField)
      .map(({ name: field }) => ({ field, type, label: `${field} (${type})` })),
  );
}

/** Every stored spelling uses the same target resolver as the page picker. */
export function linksAgent(
  entry: Entry,
  field: string,
  agent: Entry,
  entries: readonly Entry[],
  schema: Schema,
): boolean {
  return (
    entry.parseError === null &&
    isAgentEntry(agent) &&
    agentFieldsOf(entry.type, schema).some((f) => f.name === field) &&
    (entry.relationships[field] ?? []).some(
      (target) => resolveTarget(target, entries)?.path === agent.path,
    )
  );
}

export const assignmentPrefix = (field: string): string =>
  `assigned:${sha256Hex(field).slice(0, 8)}:`;

export interface AssignmentRelease {
  agent: string;
  subject: string;
  keyPrefix: string;
}

function inside(trigger: Trigger, path: string): boolean {
  return trigger.in === undefined || path === trigger.in || path.startsWith(`${trigger.in}/`);
}

/** Only newly gained links wake. A create can already carry its assignment. */
export function assignedWakes(
  entries: readonly Entry[],
  events: readonly VaultEvent[],
  schema: Schema,
): WakeOffer[] {
  const offers: WakeOffer[] = [];
  for (const agent of entries) {
    if (!isAgentEntry(agent) || isPaused(agent)) continue;
    const actor = agentRef(agent).actor;
    const triggers = parseTriggers(agent.properties.when).filter((t) => t.event === 'assigned');
    for (const event of events) {
      if (
        event.kind === 'moved' ||
        event.path === agent.path ||
        event.entry.hash === null ||
        event.entry.parseError !== null ||
        (event.kind === 'changed' && event.before.parseError !== null)
      )
        continue;
      const trigger = triggers.find(
        (t) =>
          t.field !== undefined &&
          inside(t, event.path) &&
          linksAgent(event.entry, t.field, agent, entries, schema) &&
          (event.kind === 'created' || !linksAgent(event.before, t.field, agent, entries, schema)),
      );
      if (trigger?.field === undefined) continue;
      const before = event.kind === 'created' ? '' : (event.before.hash ?? '');
      offers.push({
        agent: actor,
        trigger: triggerDigest(trigger),
        path: event.path,
        hash: event.entry.hash,
        event: event.kind,
        wakeKey:
          assignmentPrefix(trigger.field) +
          sha256Hex([actor, event.path, before, event.entry.hash].join('\n')).slice(0, 32),
        cause: { kind: 'assigned', subject: event.path, detail: `via ${trigger.field}` },
      });
    }
  }
  return offers;
}

/** A removal releases one agent/page/field, even if several spellings linked it. */
export function unassignments(
  entries: readonly Entry[],
  events: readonly VaultEvent[],
  schema: Schema,
): AssignmentRelease[] {
  const releases = new Map<string, AssignmentRelease>();
  for (const event of events) {
    if (event.kind !== 'changed' || event.entry.parseError !== null) continue;
    for (const field of agentFieldsOf(event.before.type, schema)) {
      for (const agent of entries.filter(isAgentEntry)) {
        if (
          !linksAgent(event.before, field.name, agent, entries, schema) ||
          linksAgent(event.entry, field.name, agent, entries, schema)
        )
          continue;
        const release = {
          agent: agentRef(agent).actor,
          subject: event.path,
          keyPrefix: assignmentPrefix(field.name),
        };
        releases.set(JSON.stringify(release), release);
      }
    }
  }
  return [...releases.values()];
}

/** Recheck immediately before claiming; a removed assignment never spends a run. */
export function stillAssigned(
  wake: Pick<PendingWake, 'agent' | 'cause' | 'trigger'>,
  entries: readonly Entry[],
  schema: Schema,
): boolean {
  if (wake.cause.kind !== 'assigned') return true;
  const agent = entries.find(
    (entry) => isAgentEntry(entry) && agentRef(entry).actor === wake.agent,
  );
  const subject = entries.find((entry) => entry.path === wake.cause.subject);
  if (agent === undefined || subject === undefined || isPaused(agent)) return false;
  const trigger = parseTriggers(agent.properties.when).find(
    (t) => t.event === 'assigned' && triggerDigest(t) === wake.trigger,
  );
  return (
    trigger?.field !== undefined &&
    inside(trigger, subject.path) &&
    linksAgent(subject, trigger.field, agent, entries, schema)
  );
}

/** Agents from newly linked filing hosts, as one addition to the human patch.
 * Explicit assignment wins, and a field with several possible destinations
 * has no implied default. Old assignments survive a move or an unfiling. */
export function inheritedAgentsPatch(
  before: Entry | null,
  type: string | null,
  patch: Readonly<Record<string, unknown>>,
  entries: readonly Entry[],
  schema: Schema,
): Record<string, unknown> | null {
  const receiving = agentFieldsOf(type, schema);
  if (type === null || receiving.length !== 1) return null;
  const [field] = receiving;
  if (Object.hasOwn(patch, field.name)) return null;
  const old = before?.relationships[field.name] ?? [];
  const already = new Set(
    old.flatMap((raw) => {
      const target = resolveTarget(raw, entries);
      return target === null ? [] : [target.path];
    }),
  );
  const gained: Entry[] = [];
  for (const { hostType, field: filing } of filingFields(type, schema)) {
    if (!Object.hasOwn(patch, filing)) continue;
    const previous = new Set(
      (before?.relationships[filing] ?? []).flatMap((raw) => {
        const target = resolveTarget(raw, entries);
        return target === null ? [] : [target.path];
      }),
    );
    for (const raw of parseWikilinks(patch[filing]) ?? []) {
      const host = resolveTarget(raw, entries);
      if (
        host === null ||
        host.type !== hostType ||
        host.parseError !== null ||
        previous.has(host.path)
      )
        continue;
      for (const agentField of agentFieldsOf(host.type, schema)) {
        for (const target of host.relationships[agentField.name] ?? []) {
          const agent = resolveTarget(target, entries);
          if (agent === null || !isAgentEntry(agent) || already.has(agent.path)) continue;
          already.add(agent.path);
          gained.push(agent);
        }
      }
    }
  }
  if (gained.length === 0 || (field.limit === 1 && (old.length > 0 || gained.length !== 1)))
    return null;
  return {
    [field.name]: [
      ...old.map(formatWikilink),
      ...gained.map((agent) => formatWikilink(linkTargetOf(agent))),
    ],
  };
}

/** Only the patch operations from an opted-in human action inherit. */
export function withInheritedAgents(
  ops: readonly BatchOp[],
  entries: readonly Entry[],
  schema: Schema,
): BatchOp[] {
  return ops.map((op) => {
    if (op.op !== 'patch') return op;
    const before = entries.find((entry) => entry.path === op.path);
    if (before === undefined) return op;
    const type = Object.hasOwn(op.set, 'type')
      ? typeof op.set.type === 'string'
        ? op.set.type
        : null
      : before.type;
    const extra = inheritedAgentsPatch(before, type, op.set, entries, schema);
    return extra === null ? op : { ...op, set: { ...op.set, ...extra } };
  });
}
