import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { isVaultPath } from '@/mermaid/flowchart/linkTargets';
import type { FlowchartModel } from '@/mermaid/flowchart/model';
import { nodeLinks, parseFlowchart, serialize } from '@/mermaid/flowchart/model';
import { addNode, setNodeLink } from '@/mermaid/flowchart/ops';

/**
 * Record bindings on a whiteboard (M29.47, spec D8).
 *
 * A node is BOUND when the model carries a `click <id> "<target>"` line —
 * Stage F's understood kind — whose target names a vault entry. The canvas
 * stores nothing but that reference: the record stays source-of-truth, and a
 * retitle, a status change or a delete is answered by re-reading the entry,
 * never by rewriting the `.mmd`.
 */
export interface RecordBinding {
  entry: Entry;
  /** The target as STORED — usually a path, but a hand-authored stem binds too. */
  target: string;
  /**
   * True when a click statement the editor does not own also writes this slot
   * (`nodeLinks`). The chip and the picture can then disagree: mermaid applies
   * the last writer, and that writer is not ours until `setNodeLink` runs. A
   * chip that stayed quiet about it would be asserting something it cannot
   * know.
   */
  contested: boolean;
}

/**
 * Which entry a click target names, or null.
 *
 * Three passes, narrowest first. A target carrying a URI scheme is refused
 * outright — the same `isVaultPath` reading the link badge classifies stored
 * targets with, so a `https://` or `mailto:` line can never be dressed up as a
 * record even if some entry happened to be titled after it. Then the exact
 * vault path, which is what "Add record" writes and what survives a retitle.
 * Then the wikilink resolver (stem → project folder → title), so a
 * hand-authored `click a "ship-v2"` binds as well as a generated one.
 */
export function resolveBinding(target: string, entries: Entry[]): Entry | null {
  if (!isVaultPath(target)) return null;
  const exact = entries.find((e) => e.path === target);
  if (exact !== undefined) return exact;
  return resolveTarget(target, entries);
}

/**
 * Every bound node in a PARSED model: node id → the record its click line
 * names. The form for a caller that already holds a model — the overlay
 * measures from the DOM on every plane mutation and must not re-parse the
 * source to answer a question it answered when the source last changed.
 *
 * Built on `nodeLinks`, not on a private walk of `model.lines`, and that is
 * load-bearing twice over. It is the one reader that knows which owned line
 * mermaid would actually apply (the last one), and it is the only source of
 * `contested`. It also carries the trap this map inherits wholesale: a node
 * linked ONLY by a variant we do not own (`click a href "…"`) has NO ENTRY
 * here at all — so "absent from this map" means "no link we can read", never
 * "this node is unbound". Anything that treats absence as unbound (the "Add
 * record" offer list does, deliberately) has to be able to live with a
 * duplicate rather than with a wrong claim.
 */
export function modelRecordBindings(
  model: FlowchartModel,
  entries: Entry[],
): Map<string, RecordBinding> {
  const out = new Map<string, RecordBinding>();
  for (const [id, link] of nodeLinks(model)) {
    const entry = resolveBinding(link.target, entries);
    if (entry !== null) out.set(id, { entry, target: link.target, contested: link.contested });
  }
  return out;
}

/** The same map from source text; empty when the source is not a flowchart. */
export function recordBindings(code: string, entries: Entry[]): Map<string, RecordBinding> {
  const model = parseFlowchart(code);
  return model === null ? new Map() : modelRecordBindings(model, entries);
}

/**
 * Why an insertion did not happen. TWO causes, and they are not the same news
 * to tell a user, which is the whole reason this is not a `null`:
 *
 * - `opaque` — the source is not an editable flowchart (the opacity rule every
 *   structural op obeys). Nothing can be placed here at all.
 * - `unbindable` — the flowchart is fine, but a click line cannot carry THIS
 *   record's path. Reachable: `clickTarget` refuses a blank target and
 *   substitutes `"` (which has no escape inside a quoted target), so a file
 *   whose name contains a double quote — legal on macOS — serializes to a
 *   target that no longer names it.
 */
export type InsertRefusal = 'opaque' | 'unbindable';

export type InsertRecordResult =
  /** `id` is the minted node's model id, so a host can place it (M29.52). */
  { ok: true; code: string; id: string } | { ok: false; reason: InsertRefusal };

/**
 * "Add record": a node labeled with the record's title plus the click line
 * binding it — TWO model ops, ONE serialize, so the whole insertion reaches
 * the host as a single `onChangeCode` and costs one undo step (spec D10).
 *
 * The `unbindable` arm exists because `setNodeLink` RETURNS A MODEL EVEN WHEN
 * IT REFUSES: serializing that would leave a node named after a record and
 * bound to nothing. So the op reads its own result back through the bindings
 * reader and discards the whole insertion, which makes a refusal a TRUE no-op
 * — no code change, no undo entry, half a record never on the canvas.
 */
export function insertRecordNode(code: string, target: Entry): InsertRecordResult {
  const model = parseFlowchart(code);
  if (model === null) return { ok: false, reason: 'opaque' };
  // An empty label emits `id[]`, which is not a node anyone can see or click.
  // The filename is the scanner's own fallback for a title, so it is the
  // honest one here too.
  const label = target.title.trim() === '' ? target.filename : target.title;
  const added = addNode(model, label);
  const next = serialize(setNodeLink(added.model, added.id, target.path));
  if (recordBindings(next, [target]).get(added.id)?.entry !== target) {
    return { ok: false, reason: 'unbindable' };
  }
  return { ok: true, code: next, id: added.id };
}
