import { placeKey, placeLabel, type Place } from '@/engine/place';
import type { Entry } from '@/engine/types';

/**
 * What the agent is being told about, as an object (M17.6).
 *
 * Context used to be a guess: the panel rebuilt a snapshot from `selection`
 * and `detailPath` on every render and folded it silently into the system
 * prompt. Two consequences, both of which the user hit:
 *
 * 1. **It was invisible.** Nothing on screen said which records the agent
 *    could see, so an answer about the wrong thing looked like the model
 *    being stupid rather than the app handing it the wrong page.
 * 2. **It followed your feet.** A resumed thread got today's surface injected
 *    as "what the user is looking at", so last week's conversation about
 *    Delivery was answered while being told it was looking at the Inbox.
 *
 * A chip fixes both by being a thing rather than a derivation: it is drawn,
 * it can be removed, and what is attached at send is what the turn is built
 * from. This is Notion's model, and it is the right one — their chat shows the
 * page as a removable chip and offers "Give context" to add more.
 */
export type ContextChip =
  /** Where the conversation is happening: the List, the type screen, the doc.
   * Carries the view's rows and filters into the snapshot. */
  | { kind: 'place'; place: Place; label: string }
  /** One record, attached whole — its properties, its body, its links. */
  | { kind: 'record'; path: string; label: string; type: string | null };

/**
 * Stable identity for a chip.
 *
 * What a dismissal remembers and what deduplicates an add. Prefixed by kind so
 * a doc place and the same doc attached as a record keep separate identities:
 * dismissing where we are must not dismiss a deliberate "read this". Which of
 * the two is DRAWN is `resolveChips`' call.
 */
export function chipId(chip: ContextChip): string {
  return chip.kind === 'place' ? `place:${placeKey(chip.place)}` : `record:${chip.path}`;
}

export function placeChip(place: Place, lookup?: Parameters<typeof placeLabel>[1]): ContextChip {
  return { kind: 'place', place, label: placeLabel(place, lookup) };
}

/** A record chip, or null when the path names nothing in the vault — a chip
 * for a deleted note would attach an empty note and say it had. */
export function recordChip(path: string, entries: Entry[]): ContextChip | null {
  const entry = entries.find((e) => e.path === path);
  if (entry === undefined) return null;
  return { kind: 'record', path, label: entry.title, type: entry.type };
}

/**
 * The chips a turn actually carries.
 *
 * `auto` is what the app offers (where you are, what is open); `dismissed` is
 * what the user took away; `added` is what they attached deliberately. Added
 * chips survive dismissal — removing a chip and then attaching the same thing
 * on purpose is a request, not a contradiction — so a re-added chip is
 * filtered out of `auto` rather than out of the result.
 *
 * A record chip for the page you are standing on is dropped (M52.3). The page
 * is already the turn's active note, body and links (M50.4), so asking about
 * the concept you are reading drew the same page twice — once as where you
 * are, once as what to read. Take the place away and the record comes back:
 * it was only ever redundant, never unwanted.
 */
export function resolveChips(
  auto: ContextChip[],
  dismissed: readonly string[],
  added: readonly ContextChip[],
): ContextChip[] {
  const addedIds = new Set(added.map(chipId));
  const kept = auto.filter((c) => !addedIds.has(chipId(c)) && !dismissed.includes(chipId(c)));
  const chips = [...kept, ...added];
  const pages = new Set(
    chips.flatMap((c) => (c.kind === 'place' && c.place.kind === 'doc' ? [c.place.path] : [])),
  );
  return chips.filter((c) => c.kind !== 'record' || !pages.has(c.path));
}
