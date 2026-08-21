import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { studioProjects } from './studio';

describe('studioProjects', () => {
  it('groups pages by prototype folder, main page first', () => {
    const projects = studioProjects([
      makeEntry({ path: 'studio/landing/index.md', title: 'Landing page' }),
      makeEntry({ path: 'studio/landing/copy.md', title: 'Copy' }),
      makeEntry({ path: 'studio/landing/assets/notes.md', title: 'Asset notes' }),
      makeEntry({ path: 'records/work/a.md', title: 'Unrelated', type: 'Work item' }),
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe('landing');
    expect(projects[0].title).toBe('Landing page');
    expect(projects[0].pages.map((p) => p.path)).toEqual([
      'studio/landing/index.md',
      'studio/landing/assets/notes.md',
      'studio/landing/copy.md',
    ]);
  });

  // Null is ABSENT, not empty: a prototype without an index.md still lists,
  // titled by its slug, and the page says "no main page" rather than
  // rendering a blank preview.
  it('a prototype without index.md keeps a null main and a humanized title', () => {
    const [project] = studioProjects([
      makeEntry({ path: 'studio/pricing-experiment/scratch.md', title: 'Scratch' }),
    ]);
    expect(project.main).toBeNull();
    expect(project.title).toBe('Pricing Experiment');
    expect(project.pages.map((p) => p.path)).toEqual(['studio/pricing-experiment/scratch.md']);
  });

  // A prototype is a FOLDER — a stray file directly in studio/ has nothing
  // to scope a build to and is deliberately not adopted.
  it('ignores loose files directly in studio/', () => {
    expect(studioProjects([makeEntry({ path: 'studio/readme.md', title: 'Readme' })])).toEqual([]);
  });

  it('sorts prototypes by title', () => {
    const projects = studioProjects([
      makeEntry({ path: 'studio/zeta/index.md', title: 'Zeta' }),
      makeEntry({ path: 'studio/alpha/index.md', title: 'Alpha' }),
    ]);
    expect(projects.map((p) => p.title)).toEqual(['Alpha', 'Zeta']);
  });
});
