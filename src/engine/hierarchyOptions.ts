import { humanize } from './schema';
import type { ChildrenSpec, Schema } from './types';

/**
 * Descent options for one level of a hierarchy chain (M9.1).
 *
 * Extracted from ViewSettingsDialog, which built this list inline for the
 * single `childrenVia` select. The toolbar's chain editor needs the same
 * logic, and — more importantly — each level must be computed from the type
 * the PREVIOUS level lands on. That is what makes `Key result → Work item`
 * selectable once `Objective → Key result` is chosen; the old inline version
 * always computed against the view's source type, so it could only ever
 * describe the first hop.
 */

export interface DescentOption {
  value: string;
  label: string;
  /** Type the rows at this level will be, so the next level can be built. */
  resultType: string | null;
}

export const NO_DESCENT = '__none__';

/** Encode a spec as a select value. */
export function descentValue(spec: ChildrenSpec | null): string {
  if (spec === null) return NO_DESCENT;
  return spec.direction === 'forward'
    ? `forward:${spec.field}`
    : `reverse:${spec.type}:${spec.field}`;
}

/** Decode a select value back into a spec. */
export function parseDescentValue(value: string): ChildrenSpec | null {
  if (value === NO_DESCENT) return null;
  const [direction, a, b] = value.split(':');
  if (direction === 'forward' && a) return { direction: 'forward', field: a };
  if (direction === 'reverse' && a && b) return { direction: 'reverse', type: a, field: b };
  return null;
}

/**
 * Every way to descend from `fromType`.
 *
 * - **forward**: a relation `fromType` itself declares — the parent holds the
 *   list of children.
 * - **reverse**: a relation any OTHER type declares pointing back at
 *   `fromType` — the children hold the link, so the parent needs no duplicate
 *   list. This is the form the OKR data uses.
 */
export function descentOptions(fromType: string | null, schema: Schema): DescentOption[] {
  if (fromType === null) return [];
  const options: DescentOption[] = [];

  const own = schema.types.get(fromType)?.fields ?? [];
  for (const f of own) {
    if (f.kind !== 'relation' && f.kind !== 'person') continue;
    options.push({
      value: `forward:${f.name}`,
      label: `${humanize(f.name)} — records this one links to`,
      resultType: f.target ?? null,
    });
  }

  for (const [typeName, def] of schema.types) {
    for (const f of def.fields) {
      if (f.kind !== 'relation' || f.target !== fromType) continue;
      options.push({
        value: `reverse:${typeName}:${f.name}`,
        label: `${typeName} — records linking back via ${humanize(f.name).toLowerCase()}`,
        resultType: typeName,
      });
    }
  }

  return options;
}

/**
 * The type each level of a chain lands on, starting from the view's source.
 * Index 0 is the root type; index n+1 is what level n descends into. A null
 * entry means the relation declares no target, so the next level cannot be
 * offered any options — the chain ends there.
 */
export function chainTypes(
  sourceType: string | null,
  hierarchy: ChildrenSpec[],
  schema: Schema,
): (string | null)[] {
  const types: (string | null)[] = [sourceType];
  for (const spec of hierarchy) {
    const current = types[types.length - 1];
    if (spec.direction === 'reverse') {
      types.push(spec.type);
      continue;
    }
    const def = current === null ? undefined : schema.types.get(current);
    const field = def?.fields.find((f) => f.name === spec.field);
    types.push(field?.target ?? null);
  }
  return types;
}
