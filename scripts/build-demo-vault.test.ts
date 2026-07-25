import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SEED_DIR,
  cssColor,
  dueIso,
  loadSeedModule,
  seedItemToFrontmatter,
  slugify,
} from './build-demo-vault';

describe('slugify', () => {
  it('lowercases, strips apostrophes, hyphenates', () => {
    expect(slugify("Maya's desk")).toBe('mayas-desk');
    expect(slugify('Launch war room')).toBe('launch-war-room');
    expect(slugify('Guided onboarding GA')).toBe('guided-onboarding-ga');
    expect(slugify('FLD-7')).toBe('fld-7');
  });
});

describe('cssColor', () => {
  it('maps var(--token) references to DS hex values', () => {
    expect(cssColor('var(--swatch-teal)')).toBe('#14B8A6');
    expect(cssColor('var(--warn-500)')).toBe('#DE8F0A');
    expect(cssColor('var(--n-400)')).toBe('#A8AFC2');
  });

  it('passes hex values through and rejects unknown tokens', () => {
    expect(cssColor('#3D8BE8')).toBe('#3D8BE8');
    expect(() => cssColor('var(--not-a-token)')).toThrow(/not-a-token/);
  });
});

describe('dueIso', () => {
  it('converts the seed dueN day number to an ISO 2026 date', () => {
    expect(dueIso(918)).toBe('2026-09-18');
    expect(dueIso(723)).toBe('2026-07-23');
    expect(dueIso(801)).toBe('2026-08-01');
  });
});

describe('seedItemToFrontmatter', () => {
  const projectSlugById = new Map([['pj-onb', 'guided-onboarding-ga']]);

  it('maps a seed work item to frontmatter with wikilinks and ISO due date', () => {
    const fm = seedItemToFrontmatter(
      {
        id: 'wi-7',
        key: 'FLD-7',
        name: 'Checklist stalls on step 3 offline',
        type: 'bug',
        status: 'progress',
        priority: 'urgent',
        assignee: 'Sam Ito',
        dueN: 722,
        estimate: 'S',
        projectId: 'pj-onb',
      },
      projectSlugById,
    );
    expect(fm).toEqual({
      type: 'Work item',
      key: 'FLD-7',
      project: '[[guided-onboarding-ga]]',
      status: 'progress',
      priority: 'urgent',
      assignee: '[[sam-ito]]',
      due: '2026-07-22',
      estimate: 'S',
    });
  });

  it('returns null for seed items attached to a work list (listId)', () => {
    const fm = seedItemToFrontmatter(
      {
        id: 'wi-18',
        key: 'TRI-1',
        name: 'App crash on photo capture (Pixel 8)',
        type: 'bug',
        status: 'progress',
        priority: 'urgent',
        assignee: 'Sam Ito',
        dueN: 722,
        estimate: 'S',
        listId: 'l-triage',
      },
      projectSlugById,
    );
    expect(fm).toBeNull();
  });
});

describe('loadSeedModule', () => {
  it('evaluates the prototype seed file and returns the requested constants', () => {
    const { SPACES, PROJECTS, WORK_ITEMS } = loadSeedModule(
      join(SEED_DIR, 'cerebro-work-data.js'),
      ['SPACES', 'PROJECTS', 'WORK_ITEMS'],
    ) as { SPACES: unknown[]; PROJECTS: unknown[]; WORK_ITEMS: unknown[] };
    expect(SPACES).toHaveLength(5);
    expect(PROJECTS).toHaveLength(4);
    expect(WORK_ITEMS.length).toBeGreaterThan(40);
  });

  it('evaluates cerebro-data.js and returns USERS', () => {
    const { USERS } = loadSeedModule(join(SEED_DIR, 'cerebro-data.js'), ['USERS']) as {
      USERS: { name: string }[];
    };
    expect(USERS).toHaveLength(12);
    expect(USERS[0].name).toBe('Maya Chen');
  });
});
