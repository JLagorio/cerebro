import { describe, expect, it } from 'vitest';
import { CATEGORIES, cycle, defaultActive, filterRows, type RowCategory } from './model';
describe('palette categories', () => {
  it('cycles both ways through the five chips', () => {
    expect(CATEGORIES.map((c) => cycle(c.id))).toEqual([
      'pages',
      'databases',
      'places',
      'commands',
      'all',
    ]);
    expect(cycle('all', true)).toBe('commands');
  });
  it('keeps Ask in every category without ever making it the default', () => {
    const rows = ['ask', 'pages', 'databases', 'places', 'commands'].map((category) => ({
      category: category as RowCategory,
    }));
    expect(defaultActive(rows)).toBe(1);
    for (const category of CATEGORIES.slice(1))
      expect(filterRows(rows, category.id).map((r) => r.category)).toEqual(['ask', category.id]);
    expect(defaultActive([{ category: 'ask' }])).toBe(-1);
    expect(defaultActive([])).toBe(-1);
  });
});
