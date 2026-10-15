import { serializeDateProperty, type DateValue } from './dates';
import { statusFieldOf } from './pageCard';
import { draftEntry, initialStatus } from './recordDraft';
import { isReservedTypeName } from './typeCatalog';
import type { Entry, FieldDef, Schema, TypeDef } from './types';
import { formatWikilink, linkTargetOf, resolveTarget } from './wikilink';

export interface ChecklistLine {
  blockId: string;
  checked: boolean;
  title: string;
  due: DateValue | null;
  extraDates: DateValue[];
  people: string[];
  flattened: boolean;
  onlyLink: boolean;
  text: string;
  /** The selected line's content and properties, to detect intervening edits. */
  snapshot: string;
}

export interface PromotionMapping {
  status: FieldDef;
  deadline: FieldDef | null;
  people: FieldDef[];
  parents: FieldDef[];
  parentDefault: string | null;
}
export interface PromotionChoices {
  person: string | null;
  parent: string | null;
}
export type LinePlan =
  | { kind: 'skip'; reason: 'empty' | 'link' }
  | {
      kind: 'create';
      title: string;
      values: Record<string, unknown>;
      body: string;
      notes: string[];
    };

export function promotionTargets(schema: Schema): TypeDef[] {
  return [...schema.types.values()]
    .filter(
      (type) =>
        !isReservedTypeName(type.name) && type.fields.some((field) => field.kind === 'status'),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function promotionMapping(
  type: string,
  source: Entry | null,
  schema: Schema,
): PromotionMapping | null {
  const definition = schema.types.get(type);
  const status = statusFieldOf(draftEntry(type, {}), schema);
  if (definition === undefined || status === null || isReservedTypeName(type)) return null;
  const parents =
    source === null || source.type === null || statusFieldOf(source, schema) === null
      ? []
      : definition.fields.filter(
          (field) =>
            field.kind === 'relation' &&
            field.from === undefined &&
            field.target === source.type &&
            (source.type !== type || field.limit === 1),
        );
  return {
    status,
    deadline:
      definition.fields.find(
        (field) => field.name === definition.deadline && ['date', 'daterange'].includes(field.kind),
      ) ?? null,
    people: definition.fields.filter(
      (field) => field.kind === 'person' && field.from === undefined,
    ),
    parents,
    parentDefault: parents.length === 1 ? parents[0].name : null,
  };
}

export function planLine(
  line: ChecklistLine,
  type: string,
  source: Entry | null,
  mapping: PromotionMapping,
  choices: PromotionChoices,
  entries: readonly Entry[],
  schema: Schema,
): LinePlan {
  if (line.title.trim() === '') return { kind: 'skip', reason: 'empty' };
  if (line.onlyLink) return { kind: 'skip', reason: 'link' };
  const values: Record<string, unknown> = {};
  const notes: string[] = [];
  let keepText = line.flattened || line.extraDates.length > 0;
  const statuses = schema.statusSetFor(draftEntry(type, {}));
  const status = line.checked
    ? statuses.find((candidate) => candidate.group === 'done')?.id
    : initialStatus(type, schema);
  if (status != null) values[mapping.status.name] = status;
  else keepText = true;
  if (line.due !== null) {
    const deadline = mapping.deadline;
    if (deadline?.kind === 'date' || deadline?.kind === 'daterange') {
      values[deadline.name] = serializeDateProperty(line.due, deadline.kind);
      if (deadline.kind === 'date' && line.due.end != null) keepText = true;
    } else {
      notes.push(`The date stays in the page: ${type} has no deadline field.`);
      keepText = true;
    }
  }
  if (line.people.length > 0) {
    const person = mapping.people.find((field) => field.name === choices.person);
    if (person === undefined) {
      notes.push(`The people stay in the page: ${type} has no person field.`);
      keepText = true;
    } else {
      let people = [
        ...new Set(
          line.people.map((raw) => {
            const target = resolveTarget(raw, entries);
            return target === null ? raw : linkTargetOf(target);
          }),
        ),
      ];
      if (person.limit === 1 && people.length > 1) {
        people = people.slice(0, 1);
        notes.push(`Kept the first person: ${person.name} holds one.`);
        keepText = true;
      }
      values[person.name] = people.map(formatWikilink);
    }
  }
  if (source !== null && mapping.parents.some((field) => field.name === choices.parent))
    values[choices.parent!] = formatWikilink(linkTargetOf(source));
  const preserved = line.checked && status === undefined ? `- [x] ${line.text}` : line.text;
  return {
    kind: 'create',
    title: line.title.trim(),
    values,
    body: `# ${line.title.trim()}\n${keepText ? `\n${preserved}\n` : ''}`,
    notes,
  };
}
