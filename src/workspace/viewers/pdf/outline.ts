export interface OutlineItem {
  title: string;
  page: number | null;
  children: OutlineItem[];
}
interface RawOutline {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutline[];
}
export interface OutlineDocument {
  numPages: number;
  getOutline(): Promise<RawOutline[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}
export async function toOutline(doc: OutlineDocument): Promise<OutlineItem[]> {
  const destination = async (value: RawOutline['dest']): Promise<number | null> => {
    try {
      const dest = typeof value === 'string' ? await doc.getDestination(value) : value;
      if (!Array.isArray(dest) || dest.length === 0) return null;
      const first: unknown = dest[0];
      const index =
        typeof first === 'number'
          ? first
          : first !== null &&
              typeof first === 'object' &&
              'num' in first &&
              'gen' in first &&
              typeof first.num === 'number' &&
              typeof first.gen === 'number'
            ? await doc.getPageIndex({ num: first.num, gen: first.gen })
            : -1;
      return Number.isInteger(index) && index >= 0 && index < doc.numPages ? index + 1 : null;
    } catch {
      return null;
    }
  };
  const walk = (rows: RawOutline[]): Promise<OutlineItem[]> =>
    Promise.all(
      rows.map(async (row) => ({
        title: row.title,
        page: await destination(row.dest),
        children: await walk(row.items),
      })),
    );
  return walk((await doc.getOutline()) ?? []);
}
