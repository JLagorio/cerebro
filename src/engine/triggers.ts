import type { VaultEvent } from './events';
import type { Entry } from './types';

/**
 * When an agent runs, beyond the clock (M17.12).
 *
 * ## Two layers, and the order is the design
 *
 * ClickUp converged on a deterministic gate BEFORE the model gate, and it is
 * the right shape for a reason that has nothing to do with imitation: the
 * cheap, checkable, auditable condition should decide whether a model is
 * consulted at all. A trigger that asks a model "did something important
 * happen?" on every vault change is a trigger that costs money to be idle, and
 * whose behaviour cannot be explained from the record.
 *
 * So: `when:` is answered from the scanned frontmatter alone — no model, no
 * tokens, and a person reading the record can say exactly what will fire it.
 * Only once it passes does `ask:` get evaluated, and that is a full agent turn
 * whose first job is to answer yes or no.
 *
 * ## What it can ask about
 *
 * Only what the scanner already parsed. `event`, `field`, `to`, `in` are all
 * answerable from an Entry and its predecessor, which is what makes layer one
 * deterministic. There is deliberately no `matches:` regex or expression
 * language: the moment a trigger needs one, the honest answer is `ask:`.
 */
export interface Trigger {
  /** created | changed | moved. Absent matches any of the three. */
  event?: VaultEvent['kind'];
  /** A property that must have changed (`changed` only). */
  field?: string;
  /** The value that property must now hold. */
  to?: string;
  /** A folder the record must be in. Prefix-matched at a separator, so `work`
   * never matches `workspace/` — the same rule scope uses. */
  in?: string;
  /**
   * The model gate: a yes/no question the agent answers before doing the work.
   *
   * Layer two, and only reached when layer one has already passed. Kept as
   * prose because that is the one thing a model is better at than a rule —
   * "does this actually threaten the release" is not expressible in
   * frontmatter, and pretending otherwise is how condition languages grow
   * until nobody can read them.
   */
  ask?: string;
  /**
   * What to do WHEN this particular trigger fires (M18.5).
   *
   * Added on top of the agent's standing instructions, never in place of
   * them, and this is a different thing from `ask:` — that decides WHETHER to
   * act, this shapes the acting. ClickUp separates the two for a reason worth
   * copying: one agent usefully answers differently depending on what woke it
   * ("a status went to at-risk → check the release date; a new record
   * appeared → just file it"), and the alternative is either three agents
   * that share 90% of their prose or one prose blob full of "if you were
   * woken by…" that the model has to disambiguate every run.
   */
  do?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/**
 * Parse `when:` frontmatter. Tolerant, like every other property: an entry
 * that cannot be read is skipped rather than failing the record, because a
 * malformed trigger should cost one trigger and not the whole agent.
 */
export function parseTriggers(raw: unknown): Trigger[] {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: Trigger[] = [];
  for (const item of items) {
    // A bare string is the common case said the short way: `when: created`.
    if (typeof item === 'string') {
      const event = str(item);
      if (event === 'created' || event === 'changed' || event === 'moved') out.push({ event });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const event = str(r.event);
    const trigger: Trigger = {
      ...(event === 'created' || event === 'changed' || event === 'moved' ? { event } : {}),
      ...(str(r.field) === undefined ? {} : { field: str(r.field) }),
      ...(str(r.to) === undefined ? {} : { to: str(r.to) }),
      ...(str(r.in) === undefined
        ? {}
        : {
            in: str(r.in)!
              .replace(/^\.?\/+/, '')
              .replace(/\/+$/, ''),
          }),
      ...(str(r.ask) === undefined ? {} : { ask: str(r.ask) }),
      ...(str(r.do) === undefined ? {} : { do: str(r.do) }),
    };
    // A trigger that constrains nothing would fire on every change in the
    // vault. That is never what someone meant to write, so it is not a
    // trigger — it is a typo, and firing on it would be the worst outcome.
    if (Object.keys(trigger).length > 0) out.push(trigger);
  }
  return out;
}

function inFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function valueOf(entry: Entry, field: string): string {
  const property = entry.properties[field];
  if (property !== undefined && property !== null) return String(property).trim();
  const linked = entry.relationships[field];
  return Array.isArray(linked) ? linked.join(', ') : '';
}

/**
 * Layer one: does this event satisfy this trigger, from the record alone?
 *
 * Every clause is AND — a trigger names the situation it wants, and a
 * partially-matching situation is not that situation.
 */
export function fires(trigger: Trigger, event: VaultEvent): boolean {
  if (trigger.event !== undefined && trigger.event !== event.kind) return false;
  if (trigger.in !== undefined && !inFolder(event.path, trigger.in)) return false;
  if (trigger.field !== undefined) {
    // A field condition is about a CHANGE, so it can only be satisfied by one.
    // `created` with `field:` would otherwise fire on every new record that
    // happens to carry the property — which is every record of that type.
    if (event.kind !== 'changed') return false;
    if (!event.fields.includes(trigger.field)) return false;
  }
  if (trigger.to !== undefined) {
    const field = trigger.field;
    if (field === undefined) return false;
    if (valueOf(event.entry, field).toLowerCase() !== trigger.to.toLowerCase()) return false;
  }
  return true;
}

/** The first trigger this event satisfies, or null. Ordered, so a record can
 * put its most specific condition first and know it wins. */
export function firstMatch(triggers: readonly Trigger[], event: VaultEvent): Trigger | null {
  return triggers.find((t) => fires(t, event)) ?? null;
}

/** One line per trigger, for the record's own page and for the builder. The
 * point is that a person can read what will fire this without running it. */
export function describeTrigger(trigger: Trigger): string {
  const parts: string[] = [];
  parts.push(
    trigger.event === 'created'
      ? 'a record is created'
      : trigger.event === 'moved'
        ? 'a record is moved'
        : trigger.event === 'changed'
          ? 'a record changes'
          : 'a record is created, changed or moved',
  );
  if (trigger.in !== undefined) parts.push(`in ${trigger.in}`);
  if (trigger.field !== undefined) {
    parts.push(trigger.to === undefined ? `and ${trigger.field} changes` : '');
    if (trigger.to !== undefined) parts.push(`and ${trigger.field} becomes ${trigger.to}`);
  }
  const when = parts.filter((p) => p !== '').join(' ');
  // The two layers read in the order they run: the deterministic clause, then
  // the model gate, then what this waking in particular is for. A sentence
  // that hid either half would defeat the point of the summary — you should be
  // able to say what a trigger will do without running it.
  const tail = [
    ...(trigger.ask === undefined ? [] : [`ask: ${trigger.ask}`]),
    ...(trigger.do === undefined ? [] : [`then: ${trigger.do}`]),
  ];
  return tail.length === 0 ? `When ${when}.` : `When ${when} — ${tail.join(' — ')}`;
}
