import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { isVaultPath } from '@/mermaid/flowchart/linkTargets';
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
 * Every bound node in `code`: node id → the record its click line names.
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
export function recordBindings(code: string, entries: Entry[]): Map<string, RecordBinding> {
  const out = new Map<string, RecordBinding>();
  const model = parseFlowchart(code);
  if (model === null) return out;
  for (const [id, link] of nodeLinks(model)) {
    const entry = resolveBinding(link.target, entries);
    if (entry !== null) out.set(id, { entry, target: link.target, contested: link.contested });
  }
  return out;
}

/**
 * "Add record": a node labeled with the record's title plus the click line
 * binding it — TWO model ops, ONE serialize, so the whole insertion reaches
 * the host as a single `onChangeCode` and costs one undo step (spec D10).
 *
 * Null means NOTHING WAS INSERTED, and it covers two different refusals:
 *
 * - the source is not an editable flowchart (the opacity rule every structural
 *   op obeys);
 * - the binding did not take. `setNodeLink` returns a model even when it
 *   refuses — a blank target is not a link, so it writes no line — and
 *   serializing that would leave a node named after a record and bound to
 *   nothing. The op reads its own result back through `recordBindings` and
 *   discards the whole insertion instead, so a refusal is a TRUE no-op: no
 *   code change, no undo entry, half a record never on the canvas.
 */
export function insertRecordNode(code: string, target: Entry): string | null {
  const model = parseFlowchart(code);
  if (model === null) return null;
  // An empty label emits `id[]`, which is not a node anyone can see or click.
  // The filename is the scanner's own fallback for a title, so it is the
  // honest one here too.
  const label = target.title.trim() === '' ? target.filename : target.title;
  const added = addNode(model, label);
  const next = serialize(setNodeLink(added.model, added.id, target.path));
  if (recordBindings(next, [target]).get(added.id)?.entry !== target) return null;
  return next;
}
