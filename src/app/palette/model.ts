export const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'pages', label: 'Pages' },
  { id: 'databases', label: 'Databases' },
  { id: 'places', label: 'Places' },
  { id: 'commands', label: 'Commands' },
] as const;
export type Category = (typeof CATEGORIES)[number]['id'];
export type RowCategory = Exclude<Category, 'all'> | 'ask';
export type Chooser = 'theme' | 'favorites' | 'agents';
export type Level =
  | { kind: 'root' }
  | {
      kind: Chooser;
      query: string;
      active: number;
      category: Category;
    };
export function cycle(category: Category, backwards = false): Category {
  const index = CATEGORIES.findIndex((c) => c.id === category);
  return CATEGORIES[(index + (backwards ? -1 : 1) + CATEGORIES.length) % CATEGORIES.length].id;
}
export function filterRows<T extends { category: RowCategory }>(
  rows: readonly T[],
  category: Category,
): T[] {
  return rows.filter(
    (row) => category === 'all' || row.category === category || row.category === 'ask',
  );
}
export function defaultActive(rows: readonly { category: RowCategory }[]): number {
  return rows.findIndex((row) => row.category !== 'ask');
}
