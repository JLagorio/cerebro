import { closeHistory } from 'prosemirror-history';
import { chipPropsToDateValue, type DateValue } from '@/engine/dates';
import type { ChecklistLine } from '@/engine/promote';
import type { Entry } from '@/engine/types';
import { linkTargetOfPath } from '@/engine/wikilink';
import { wikilinkLabel } from './chipLabels';
import { chipText } from './markdown';
import type { CerebroEditor } from './MarkdownEditor';

interface BlockSource {
  id: string;
  type: string;
  props?: unknown;
  content?: unknown;
  children?: readonly BlockSource[];
}
const snapshot = (block: BlockSource) => JSON.stringify([block.type, block.props, block.content]);

/** Read the selected JSON, never the DOM: chips have their own plain-text
 * carriers and link labels are the same ones the page renders. */
export function readChecklistLine(
  block: BlockSource,
  entries: Entry[],
  notePath: string | null = null,
): ChecklistLine | null {
  if (block.type !== 'checkListItem') return null;
  const dates: DateValue[] = [];
  const people: string[] = [];
  let flattened = false;
  const title: string[] = [];
  const text: string[] = [];
  const significant: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item !== 'object' || item === null) return;
    const node = item as {
      type?: string;
      text?: string;
      href?: string;
      content?: unknown[];
      styles?: Record<string, unknown>;
      props?: Record<string, string>;
    };
    const props = node.props ?? {};
    if (node.type === 'text') {
      title.push(node.text ?? '');
      text.push(node.text ?? '');
      if (node.text?.trim()) significant.push('text');
      if (Object.keys(node.styles ?? {}).length > 0) flattened = true;
    } else if (node.type === 'link') {
      flattened = true;
      const label = (node.content ?? [])
        .map((part) => (part as { text?: string }).text ?? '')
        .join('');
      title.push(label);
      text.push(`[${label}](${node.href ?? ''})`);
      significant.push('link');
    } else {
      const carrier = chipText(item);
      if (carrier !== null) text.push(carrier);
      if (node.type === 'due') dates.push(chipPropsToDateValue(props));
      else if (node.type === 'assignee') {
        if (props.target) people.push(props.target);
      } else if (node.type === 'wikilink') {
        title.push(
          wikilinkLabel(
            { target: props.target ?? '', alias: props.alias ?? '' },
            entries,
            notePath,
          ),
        );
        significant.push('link');
        flattened = true;
      } else flattened = true;
    }
  };
  if (Array.isArray(block.content)) block.content.forEach(visit);
  return {
    blockId: block.id,
    checked: (block.props as { checked?: boolean } | undefined)?.checked === true,
    title: title.join('').replace(/\s+/g, ' ').trim(),
    due: dates[0] ?? null,
    extraDates: dates.slice(1),
    people: [...new Set(people)],
    flattened,
    onlyLink: significant.length === 1 && significant[0] === 'link',
    text: text.join('').trim(),
    snapshot: snapshot(block),
  };
}

export function promotable(
  blocks: readonly BlockSource[],
  entries: Entry[],
  notePath: string | null = null,
): ChecklistLine[] {
  const found = new Map<string, ChecklistLine>();
  const visit = (block: BlockSource) => {
    const line = readChecklistLine(block, entries, notePath);
    if (line !== null) found.set(line.blockId, line);
    block.children?.forEach(visit);
  };
  blocks.forEach(visit);
  return [...found.values()];
}

/** One document transaction and one undo step. A changed or removed line
 * stays exactly as it is; the created record still exists and is reported. */
export function linkPromotedLines(
  editor: CerebroEditor,
  created: readonly { line: ChecklistLine; path: string }[],
): Set<string> {
  const linked = new Set<string>();
  const ready = created.filter(({ line }) => {
    const block = editor.getBlock(line.blockId);
    return block !== undefined && snapshot(block) === line.snapshot;
  });
  if (ready.length === 0) return linked;
  editor.transact((tr) => {
    closeHistory(tr);
    for (const { line, path } of ready) {
      editor.updateBlock(line.blockId, {
        type: 'bulletListItem',
        content: [{ type: 'wikilink', props: { target: linkTargetOfPath(path), alias: '' } }],
      });
      linked.add(line.blockId);
    }
  });
  return linked;
}
