import type { FieldProposal, TypeProposal } from '@/engine/adopt';
import { humanize } from '@/engine/schema';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ensureTypeDoc, findTypeDoc } from '@/app/typeActions';

export interface AdoptionResult {
  types: number;
  fields: number;
  converted: number;
  cleared: number;
}

/** Status ids that read as finished/abandoned, for the seeded group. */
const DONE_WORDS = new Set(['done', 'complete', 'completed', 'shipped', 'closed', 'resolved']);
const CLOSED_WORDS = new Set(['cancelled', 'canceled', 'archived', 'wont-do', 'wontfix', 'dropped']);

function fieldSpec(f: FieldProposal): unknown {
  const spec: Record<string, unknown> = { kind: f.kind };
  if (f.options !== null && (f.kind === 'select' || f.kind === 'multiselect')) {
    spec.options = f.options;
  }
  if (f.kind === 'relation' && f.target !== null) spec.target = f.target;
  return f.kind === 'text' ? 'text' : spec;
}

/**
 * Execute an approved adoption plan (M12.6): declare each proposed type's
 * fields on its Type doc (creating ghost types' docs), then convert every
 * record value the plan flagged. Doc writes go first so the conversions
 * validate against the new schema. Returns counts, or null on failure —
 * the Repair Vault contract: idempotent, and it tells you what it did.
 */
export async function applyAdoption(
  proposals: TypeProposal[],
  isIncluded: (typeName: string, fieldName: string) => boolean,
): Promise<AdoptionResult | null> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const result: AdoptionResult = { types: 0, fields: 0, converted: 0, cleared: 0 };

  try {
    for (const proposal of proposals) {
      const included = proposal.fields.filter((f) => isIncluded(proposal.name, f.name));
      const toDeclare = included.filter((f) => !f.declared);

      // The Type doc: created for ghosts, extended for declared types.
      const specs = Object.fromEntries(toDeclare.map((f) => [f.name, fieldSpec(f)]));
      const statusField = toDeclare.find((f) => f.kind === 'status' && f.options !== null);
      const statuses = statusField?.options?.map((id) => ({
        id,
        group: DONE_WORDS.has(id.toLowerCase())
          ? 'done'
          : CLOSED_WORDS.has(id.toLowerCase())
            ? 'closed'
            : 'active',
      }));

      const doc = findTypeDoc(entries, proposal.name);
      if (doc === null) {
        await ensureTypeDoc(
          { name: proposal.name, docPath: null },
          {
            ...(Object.keys(specs).length > 0 ? { fields: specs } : {}),
            ...(statuses !== undefined ? { statuses } : {}),
          },
        );
        result.types += 1;
      } else if (Object.keys(specs).length > 0 || statuses !== undefined) {
        const raw = (doc.properties as Record<string, unknown>).fields;
        const existing =
          typeof raw === 'object' && raw !== null && !Array.isArray(raw)
            ? { ...(raw as Record<string, unknown>) }
            : {};
        await patchFrontmatter(doc.path, {
          ...(Object.keys(specs).length > 0 ? { fields: { ...existing, ...specs } } : {}),
          ...(statuses !== undefined ? { statuses } : {}),
        });
        result.types += 1;
      }
      result.fields += toDeclare.length;

      // Conversions, batched per record — one write per file however many
      // fields disagreed.
      const perRecord = new Map<string, Record<string, unknown>>();
      for (const field of included) {
        for (const c of field.convert) {
          const patch = perRecord.get(c.path) ?? {};
          patch[field.name] = c.value;
          perRecord.set(c.path, patch);
          if (c.value === null) result.cleared += 1;
          else result.converted += 1;
        }
      }
      for (const [path, patch] of perRecord) {
        await patchFrontmatter(path, patch);
      }
    }
  } catch {
    toast("Adoption stopped partway — re-run it; it only proposes what's still missing");
    return null;
  }

  const parts = [
    `${result.types} ${result.types === 1 ? 'type' : 'types'}`,
    `${result.fields} ${result.fields === 1 ? 'field' : 'fields'}`,
  ];
  if (result.converted > 0) parts.push(`${result.converted} values converted`);
  if (result.cleared > 0) parts.push(`${result.cleared} cleared`);
  toast(`Adopted: ${parts.join(', ')}`);
  return result;
}

/** "3 converted · 1 cleared" — the wizard's per-field consequence note. */
export function convertSummary(f: FieldProposal): string | null {
  const cleared = f.convert.filter((c) => c.value === null).length;
  const converted = f.convert.length - cleared;
  if (f.convert.length === 0) return null;
  const parts: string[] = [];
  if (converted > 0) parts.push(`${converted} converted`);
  if (cleared > 0) parts.push(`${cleared} cleared`);
  return `${parts.join(' · ')} of ${humanize(f.name)}`;
}
