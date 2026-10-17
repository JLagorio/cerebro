import { composeNote, humanize } from './frontmatter';
import type { BatchOp } from './batch';
import type { Entry } from './types';
import { isKnowledgePath } from './okf';
export interface PackType {
  path: string;
  name: string;
  properties: Record<string, unknown> & { fields: Record<string, unknown> };
  body: string;
}
export interface Pack {
  name: string;
  types: readonly PackType[];
}
export interface PackPlan {
  ops: BatchOp[];
  creates: string[];
  additions: { type: string; fields: string[] }[];
  skips: string[];
  conflicts: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** A pack adds missing declarations only. Existing choices, views and bytes survive. */
export function planPack(pack: Pack, entries: readonly Entry[]): PackPlan {
  const plan: PackPlan = { ops: [], creates: [], additions: [], skips: [], conflicts: [] };
  for (const item of pack.types) {
    const matches = entries.filter(
      (e) => e.type === 'Type' && e.title.toLowerCase() === item.name.toLowerCase(),
    );
    if (matches.length > 1) {
      plan.conflicts.push(`More than one database is named ${item.name}.`);
      continue;
    }
    const held = matches[0];
    if (held === undefined) {
      if (entries.some((e) => e.path.toLowerCase() === item.path.toLowerCase())) {
        plan.conflicts.push(
          `${item.path} already holds a page that is not the ${item.name} database.`,
        );
        continue;
      }
      plan.creates.push(item.path);
      plan.ops.push({
        op: 'create',
        path: item.path,
        content: composeNote(
          { type: 'Type', ...item.properties },
          `# ${item.name}\n\n${item.body}\n`,
        ),
      });
      continue;
    }
    if (held.parseError !== null || held.hash === null || isKnowledgePath(held.path)) {
      plan.conflicts.push(`${held.path} cannot be safely updated.`);
      continue;
    }
    const raw = held.properties.fields;
    if (raw !== undefined && !object(raw)) {
      plan.conflicts.push(`${held.path} has an unreadable fields declaration.`);
      continue;
    }
    const fields = { ...((raw ?? {}) as Record<string, unknown>) };
    const additions = Object.keys(item.properties.fields).filter(
      (name) => !Object.keys(fields).some((key) => key.toLowerCase() === name.toLowerCase()),
    );
    for (const name of additions) fields[name] = item.properties.fields[name];
    if (additions.length === 0) {
      plan.skips.push(item.name);
      continue;
    }
    plan.additions.push({ type: held.title, fields: additions });
    plan.ops.push({ op: 'patch', path: held.path, set: { fields }, expectHash: held.hash });
  }
  // A conflict refuses the whole installation; the preview still explains every row.
  if (plan.conflicts.length > 0) plan.ops = [];
  return plan;
}
export function packPlanWords(plan: PackPlan): string[] {
  const join = (words: string[]) =>
    words.length < 2 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return [
    ...plan.creates.map((path) => `Creates ${path}.`),
    ...plan.additions.map(
      (row) =>
        `Adds ${join(row.fields.map((name) => humanize(name).toLowerCase()))} to ${row.type}.`,
    ),
    ...plan.skips.map((name) => `Already there: ${name}.`),
    ...plan.conflicts,
  ];
}
