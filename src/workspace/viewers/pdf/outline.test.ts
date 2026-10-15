import { expect, it, vi } from 'vitest';
import { toOutline, type OutlineDocument } from './outline';
it('resolves named and indexed destinations, preserving unavailable items', async () => {
  const doc: OutlineDocument = {
    numPages: 5,
    getPageIndex: vi.fn(async () => 2),
    getDestination: vi.fn(async () => [{ num: 4, gen: 0 }, 'Fit']),
    getOutline: async () => [
      { title: 'Named', dest: 'intro', items: [{ title: 'Indexed', dest: [4, 'Fit'], items: [] }] },
      { title: 'Broken', dest: [99, 'Fit'], items: [] },
      { title: 'External', dest: null, items: [] },
    ],
  };
  expect(await toOutline(doc)).toEqual([
    { title: 'Named', page: 3, children: [{ title: 'Indexed', page: 5, children: [] }] },
    { title: 'Broken', page: null, children: [] },
    { title: 'External', page: null, children: [] },
  ]);
  doc.getOutline = async () => null;
  expect(await toOutline(doc)).toEqual([]);
});
