// PLACEHOLDER — created in Task 11 so vaultStore can link against the schema
// module. Task 13 REPLACES this file with the full implementation. Do not
// build on the bodies below; only the exported names and signatures matter.
import type { Entry, ResolvedField, Schema, StatusDef } from './types';

export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'backlog', label: 'Backlog', color: '#A8AFC2', group: 'active' },
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'in-progress', label: 'In progress', color: '#EFB428', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
  { id: 'cancelled', label: 'Cancelled', color: '#A8AFC2', group: 'closed', hollow: true },
];

export function buildSchema(_entries: Entry[]): Schema {
  return {
    types: new Map(),
    spaceForEntry: () => null,
    statusSetForSpace: () => DEFAULT_STATUSES,
    resolveField: (e: Entry, field: string): ResolvedField => {
      const raw = e.properties[field] ?? null;
      return { def: null, raw, display: raw === null ? '' : String(raw), color: null, ghost: false };
    },
  };
}
