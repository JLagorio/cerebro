import type { PartialBlock } from '@blocknote/core';
import { closeHistory } from 'prosemirror-history';
import {
  planMerge,
  planReplace,
  type Choice,
  type MergeNode,
  type Step,
} from '@/engine/blockMerge';
import { blocksToMarkdownNow, isLossyImport, markdownToBlocksNow } from './markdown';
import type { CerebroEditor } from './MarkdownEditor';

/**
 * An outside write, applied to the open page in place (M55.6).
 *
 * The editor used to remount on every outside write: the caret, the scroll,
 * the undo history and every node view went with it, and a page with unsaved
 * typing could only take the write whole or refuse it. Here the write is
 * parsed, paired block by block against the page (`engine/blockMerge.ts`),
 * and applied as edits: a block the write did not touch is not touched, so it
 * keeps its id and its node view. A page with unsaved typing merges three
 * ways against what it last read or saved, and only blocks both sides changed
 * differently are left for the person to choose.
 *
 * Everything here is synchronous, so no keystroke lands between the plan and
 * its apply.
 */

/** A block of the live page or of a parsed write. */
export interface AnyBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: AnyBlock[];
}

/** A choice that waits on the person: mine's blocks by id, theirs whole. */
export interface OpenChoice {
  id: string;
  /** Mine's blocks in the contested span; empty when mine deleted it. */
  mine: string[];
  theirs: AnyBlock[];
  /** The block the span's level belongs to, or null at the top level. */
  parent: string | null;
  /** Mine's block before the span, which theirs follows when mine is empty. */
  after: string | null;
  /** The two sides as markdown, as they stood when the choice was made. */
  minePreview: string;
  theirsPreview: string;
}

/** What `planExternal` makes of a write. */
export type ExternalPlan =
  /** The write reads as the base: nothing to do. */
  | { kind: 'same' }
  /** The editor cannot show the write without dropping or adding text. */
  | { kind: 'unrepresentable'; dirty: boolean }
  | {
      kind: 'plan';
      /** The write's canonical text: what the page now stands on. */
      next: string;
      dirty: boolean;
      steps: Step<AnyBlock>[];
      /** The open choices after the plan lands, older ones first. */
      choices: OpenChoice[];
    };

const propSchemaOf = (editor: CerebroEditor, type: string): Record<string, { default?: unknown }> =>
  (
    editor.schema.blockSchema as Record<
      string,
      { propSchema?: Record<string, { default?: unknown }> }
    >
  )[type]?.propSchema ?? {};

/** A block's declared props that differ from their defaults, by name. */
function declaredProps(editor: CerebroEditor, block: AnyBlock): [string, unknown][] {
  const schema = propSchemaOf(editor, block.type);
  return Object.keys(schema)
    .sort()
    .flatMap((key) => {
      const value = block.props?.[key];
      return value === undefined || value === schema[key].default ? [] : [[key, value]];
    });
}

/** An object's entries sorted by key, so equal styles stringify alike. */
const sorted = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? Object.keys(value)
        .sort()
        .map((key) => [key, (value as Record<string, unknown>)[key]])
    : value;

/** Inline content as runs: empty text dropped, text of one style joined. */
function inlineRuns(content: unknown): unknown {
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content === '' ? [] : [[content, []]];
    const table = content as { type?: string; headerRows?: unknown; rows?: unknown } | undefined;
    if (table?.type !== 'tableContent' || !Array.isArray(table.rows)) return null;
    return [
      table.headerRows ?? 0,
      table.rows.map((row: { cells?: unknown[] }) =>
        (row.cells ?? []).map((cell) =>
          inlineRuns(Array.isArray(cell) ? cell : (cell as { content?: unknown }).content),
        ),
      ),
    ];
  }
  const runs: unknown[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (item.type === 'text') {
      const text = item.text as string;
      if (text === '') continue;
      const style = JSON.stringify(sorted(item.styles ?? {}));
      const last = runs.at(-1);
      if (Array.isArray(last) && last.length === 2 && last[1] === style) {
        last[0] = `${last[0] as string}${text}`;
      } else runs.push([text, style]);
    } else if (item.type === 'link') {
      runs.push({ link: item.href, content: inlineRuns(item.content) });
    } else {
      runs.push({ type: item.type, props: sorted(item.props ?? {}) });
    }
  }
  return runs;
}

const isBlank = (block: AnyBlock): boolean =>
  block.type === 'paragraph' &&
  (block.children ?? []).length === 0 &&
  (inlineRuns(block.content) as unknown[] | null)?.length === 0;

/**
 * The blocks as a plan sees them. The signature is the type, the props that
 * differ from cerebroSchema's defaults, the inline runs and the children, so
 * a parsed block and a live one with the same content sign alike. The text
 * is the block's markdown, serialized once and only when a plan asks for it.
 */
export function toNodes(editor: CerebroEditor, blocks: readonly AnyBlock[]): MergeNode<AnyBlock>[] {
  return blocks.map((block) => {
    const children = toNodes(editor, block.children ?? []);
    const own = JSON.stringify([
      block.type,
      declaredProps(editor, block),
      inlineRuns(block.content),
    ]);
    const sig = JSON.stringify([own, children.map((child) => child.sig)]);
    let text: string | undefined;
    return {
      sig,
      own,
      type: block.type,
      blank: isBlank(block),
      children,
      ref: block,
      text: () => {
        if (text === undefined) {
          try {
            text = blocksToMarkdownNow(editor, [block as PartialBlock]);
          } catch {
            // A block the serializer cannot take alone still has a content.
            text = sig;
          }
        }
        return text;
      },
    };
  });
}

/** The blocks as markdown, for a preview. */
const preview = (editor: CerebroEditor, blocks: AnyBlock[]): string => {
  if (blocks.length === 0) return '';
  try {
    return blocksToMarkdownNow(editor, blocks as PartialBlock[]).trim();
  } catch {
    return '';
  }
};

let choiceSeq = 0;

/**
 * Plan `next` (the file's body as read) against the page. `base` is the
 * canonical text the page last read or saved; the page is dirty when its
 * serialization differs from it. A clean page takes the write two-way; a
 * dirty one merges three-way against `base`. A write the editor cannot show
 * is `unrepresentable` unless `allowLoss` (an unlocked lossy page). `open`
 * are the choices already waiting: a new choice that shares a live block with
 * one of them replaces it, and the rest stay.
 */
export function planExternal(
  editor: CerebroEditor,
  {
    next,
    base,
    open = [],
    allowLoss = false,
  }: { next: string; base: string; open?: readonly OpenChoice[]; allowLoss?: boolean },
): ExternalPlan {
  const nextBlocks = markdownToBlocksNow(editor, next) as AnyBlock[];
  const nextCanon = blocksToMarkdownNow(editor, nextBlocks as PartialBlock[]);
  // Lossy first: a write whose extra text the editor would drop can read as
  // the base once parsed, and calling it the same would let the next save
  // strip it.
  if (!allowLoss && isLossyImport(next, nextCanon)) {
    return { kind: 'unrepresentable', dirty: blocksToMarkdownNow(editor) !== base };
  }
  if (nextCanon === base) return { kind: 'same' };
  const dirty = blocksToMarkdownNow(editor) !== base;
  const live = toNodes(editor, editor.document as AnyBlock[]);
  const theirs = toNodes(editor, nextBlocks);
  if (!dirty) {
    return {
      kind: 'plan',
      next: nextCanon,
      dirty,
      steps: planReplace(live, theirs),
      choices: [...open],
    };
  }
  const baseNodes = toNodes(editor, markdownToBlocksNow(editor, base) as AnyBlock[]);
  const plan = planMerge(baseNodes, live, theirs);
  const made = plan.choices.map((choice: Choice<AnyBlock>): OpenChoice => ({
    id: `merge-${++choiceSeq}`,
    mine: choice.mine.map((block) => block.id as string),
    theirs: choice.theirs,
    parent: choice.parent?.id ?? null,
    after: choice.after?.id ?? null,
    minePreview: preview(editor, choice.mine),
    theirsPreview: preview(editor, choice.theirs),
  }));
  const taken = new Set(made.flatMap((choice) => choice.mine));
  const kept = open.filter((choice) => !choice.mine.some((id) => taken.has(id)));
  return { kind: 'plan', next: nextCanon, dirty, steps: plan.steps, choices: [...kept, ...made] };
}

/** A block's own content, every declared prop filled, as `updateBlock` takes it. */
function ownUpdate(editor: CerebroEditor, block: AnyBlock): PartialBlock {
  const schema = propSchemaOf(editor, block.type);
  const props = Object.fromEntries(
    Object.keys(schema).map((key) => [key, block.props?.[key] ?? schema[key].default]),
  );
  const spec = (editor.schema.blockSchema as Record<string, { content?: string }>)[block.type];
  return (
    spec?.content === 'none' ? { props } : { props, content: block.content ?? [] }
  ) as PartialBlock;
}

const idOf = (block: AnyBlock): string => block.id as string;

/**
 * Carry out `steps` on one level of the page (`parent`'s children, or the
 * top level), then each updated block's children. Drops go first; each run
 * of inserts goes after the kept or updated block before it, or before the
 * next one at the start of a level; a level that keeps nothing is replaced,
 * or emptied.
 */
export function applySteps(
  editor: CerebroEditor,
  steps: readonly Step<AnyBlock>[],
  parent: string | null = null,
): void {
  const inserts = steps.flatMap((step) => (step.kind === 'insert' ? [step.ref] : []));
  const drops = steps.flatMap((step) => (step.kind === 'drop' ? [idOf(step.ref)] : []));
  if (!steps.some((step) => step.kind === 'keep' || step.kind === 'update')) {
    if (parent !== null) {
      // `updateBlock` ignores an empty `children`: a level emptied out is
      // removed block by block.
      if (inserts.length > 0) editor.updateBlock(parent, { children: inserts as PartialBlock[] });
      else if (drops.length > 0) editor.removeBlocks(drops);
    } else if (drops.length > 0 || inserts.length > 0) {
      editor.replaceBlocks(
        drops,
        (inserts.length > 0 ? inserts : [{ type: 'paragraph' }]) as PartialBlock[],
      );
    }
    return;
  }
  if (drops.length > 0) editor.removeBlocks(drops);
  for (const step of steps) {
    if (step.kind !== 'update') continue;
    if (step.own !== undefined) editor.updateBlock(idOf(step.ref), ownUpdate(editor, step.own));
    if (step.children !== undefined) applySteps(editor, step.children, idOf(step.ref));
  }
  let previous: string | null = null;
  let run: PartialBlock[] = [];
  const flush = (nextAnchor: string | null) => {
    if (run.length === 0) return;
    if (previous !== null) editor.insertBlocks(run, previous, 'after');
    else if (nextAnchor !== null) editor.insertBlocks(run, nextAnchor, 'before');
    run = [];
  };
  for (const step of steps) {
    if (step.kind === 'insert') run.push(step.ref as PartialBlock);
    else if (step.kind === 'keep' || step.kind === 'update') {
      flush(idOf(step.ref));
      previous = idOf(step.ref);
    }
  }
  flush(null);
}

/**
 * Run `fn` as its own undo step. History closes before it, so the change
 * never joins the typing just before it (ProseMirror groups adjacent steps
 * made within 500 ms), and again after it, so the next keystroke starts a
 * step of its own. `closeHistory` must be the prosemirror-history BlockNote
 * loads: its meta key is made in that module, and a second copy's key would
 * close nothing.
 */
export function inPlace(editor: CerebroEditor, fn: () => void): void {
  editor.transact((tr) => {
    closeHistory(tr);
    fn();
  });
  editor.transact((tr) => {
    closeHistory(tr);
  });
}

/**
 * Settle a choice. Taking theirs puts theirs's blocks where mine's still are,
 * or after `after` when mine had none; keeping mine changes nothing.
 */
export function settleChoice(
  editor: CerebroEditor,
  choice: OpenChoice,
  pick: 'mine' | 'theirs',
): void {
  if (pick === 'mine') return;
  const theirs = choice.theirs as PartialBlock[];
  const surviving = choice.mine.filter((id) => editor.getBlock(id) !== undefined);
  inPlace(editor, () => {
    if (surviving.length > 0) {
      if (theirs.length > 0) editor.replaceBlocks(surviving, theirs);
      else editor.removeBlocks(surviving);
      return;
    }
    if (theirs.length === 0) return;
    if (choice.after !== null && editor.getBlock(choice.after) !== undefined) {
      editor.insertBlocks(theirs, choice.after, 'after');
      return;
    }
    const parent = choice.parent === null ? undefined : editor.getBlock(choice.parent);
    const level = parent === undefined ? editor.document : parent.children;
    if (level.length > 0) editor.insertBlocks(theirs, level[0], 'before');
    else if (parent !== undefined) editor.updateBlock(parent, { children: theirs });
  });
}
