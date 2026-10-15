import { createTarget } from '@/engine/createRecord';
import {
  planLine,
  promotionMapping,
  type ChecklistLine,
  type PromotionChoices,
} from '@/engine/promote';
import { recordSlug } from '@/engine/recordDraft';
import type { Entry, Schema } from '@/engine/types';
import { getSchema, refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

export type PromotionResult =
  | { line: ChecklistLine; outcome: 'created'; path: string; notes: string[] }
  | { line: ChecklistLine; outcome: 'skipped' | 'failed'; reason: string };

/** Each line answers for itself; a failed create never consumes its source
 * checklist, and cannot stop the following line from trying. */
export async function createPromoted(
  lines: readonly ChecklistLine[],
  type: string,
  source: Entry | null,
  choices: PromotionChoices,
  schema: Schema,
): Promise<PromotionResult[]> {
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  const results: PromotionResult[] = [];
  const mapping = promotionMapping(type, source, schema);
  const selectedDefinition = JSON.stringify(schema.types.get(type));
  if (vault === null || refusedAcrossVaults(state) || mapping === null)
    return lines.map((line) => ({ line, outcome: 'failed', reason: "Couldn't create the record" }));
  for (const line of lines) {
    try {
      const current = useVaultStore.getState();
      if (current.vaultPath !== vault || refusedAcrossVaults(current)) {
        results.push({ line, outcome: 'failed', reason: 'The vault changed' });
        continue;
      }
      const liveSchema = getSchema(current.entries);
      const liveSource =
        source === null
          ? null
          : (current.entries.find((entry) => entry.path === source.path) ?? null);
      const liveMapping = promotionMapping(type, liveSource, liveSchema);
      if (
        liveMapping === null ||
        JSON.stringify(liveSchema.types.get(type)) !== selectedDefinition ||
        (choices.parent !== null &&
          (liveSource === null ||
            !liveMapping.parents.some((field) => field.name === choices.parent)))
      ) {
        results.push({ line, outcome: 'failed', reason: 'The database or parent changed' });
        continue;
      }
      const plan = planLine(
        line,
        type,
        liveSource,
        liveMapping,
        choices,
        current.entries,
        liveSchema,
      );
      if (plan.kind === 'skip') {
        results.push({
          line,
          outcome: 'skipped',
          reason: plan.reason === 'empty' ? 'Empty line' : 'Already a link',
        });
        continue;
      }
      const target = createTarget(type, { entries: current.entries, schema: liveSchema });
      const path = await current.createItem({
        folder: target.folder,
        slug: recordSlug(plan.title, `record-${Date.now().toString(36)}`),
        frontmatter: { ...target.frontmatter, ...plan.values },
        body: plan.body,
      });
      results.push({ line, outcome: 'created', path, notes: plan.notes });
    } catch {
      results.push({ line, outcome: 'failed', reason: "Couldn't create the record" });
    }
  }
  return results;
}
