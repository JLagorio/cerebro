import { describe, expect, it } from 'vitest';
import { backlinksFor, outgoingFor } from './links';
import type { Entry } from './types';
import { resolveTarget } from './wikilink';

const entry = (path: string, partial: Partial<Entry> = {}): Entry => ({
  path,
  filename: path.split('/').pop() ?? path,
  folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  project: null,
  title: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
  type: null,
  properties: {},
  relationships: {},
  outgoingLinks: [],
  snippet: '',
  createdAt: '2026-07-01T00:00:00Z',
  modifiedAt: '2026-07-01T00:00:00Z',
  parseError: null,
  hash: null,
  ...partial,
});

const kickoff = entry('meetings/kickoff.md', { title: 'Kickoff' });
const spec = entry('docs/spec.md', {
  title: 'Spec',
  outgoingLinks: ['kickoff'],
  relationships: { owner: ['maya'] },
});
const maya = entry('people/maya.md', { title: 'Maya' });
const orphan = entry('docs/orphan.md');
const VAULT = [kickoff, spec, maya, orphan];

describe('outgoingFor', () => {
  it('resolves body wikilinks and relationship fields', () => {
    const links = outgoingFor(spec, VAULT);
    expect(links.map((l) => [l.entry.path, l.via])).toEqual([
      ['meetings/kickoff.md', 'body'],
      ['people/maya.md', 'owner'],
    ]);
  });

  it('drops unresolvable targets', () => {
    const broken = entry('d.md', { outgoingLinks: ['nowhere'] });
    expect(outgoingFor(broken, VAULT)).toEqual([]);
  });
});

describe('backlinksFor', () => {
  it('finds notes linking here via body or fields, labeled by how', () => {
    expect(backlinksFor(kickoff, VAULT).map((l) => [l.entry.path, l.via])).toEqual([
      ['docs/spec.md', 'body'],
    ]);
    expect(backlinksFor(maya, VAULT).map((l) => [l.entry.path, l.via])).toEqual([
      ['docs/spec.md', 'owner'],
    ]);
    expect(backlinksFor(orphan, VAULT)).toEqual([]);
  });
});

// M55.8: a section link reaches its page, so the page lists the note that
// links into it, and the note's outgoing links name the page.
describe('section links', () => {
  const plan = entry('docs/plan.md', { outgoingLinks: ['kickoff#Decisions'] });
  const vault = [kickoff, plan];

  it('outgoingFor resolves a link into a section to its page', () => {
    expect(outgoingFor(plan, vault).map((l) => [l.entry.path, l.via])).toEqual([
      ['meetings/kickoff.md', 'body'],
    ]);
  });

  it('backlinksFor lists a note that links into a section', () => {
    expect(backlinksFor(kickoff, vault).map((l) => [l.entry.path, l.via])).toEqual([
      ['docs/plan.md', 'body'],
    ]);
  });
});

/** `items` behind a Proxy that counts its index reads, so a test can bound the passes. */
function counted<T extends object>(items: T[]): { array: T[]; reads: () => number } {
  let reads = 0;
  const array = new Proxy(items, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { array, reads: () => reads };
}

// M60.9: backlinks come from one index built in one pass over the vault.
describe('the backlink index', () => {
  const via = (links: { entry: Entry; via: string }[]) => links.map((l) => [l.entry.path, l.via]);

  it('lists a note that links by item key or into a section', () => {
    const task = entry('records/work/ship-docs.md', { properties: { key: 'FLD-13' } });
    const byKey = entry('docs/a.md', { outgoingLinks: ['FLD-13'] });
    const bySection = entry('docs/b.md', { relationships: { blocks: ['fld-13#Notes'] } });
    expect(via(backlinksFor(task, [task, byKey, bySection]))).toEqual([
      ['docs/a.md', 'body'],
      ['docs/b.md', 'blocks'],
    ]);
  });

  it('gives one body backlink per source, body before fields, and never the source itself', () => {
    const target = entry('docs/target.md');
    const self = entry('docs/self.md', { outgoingLinks: ['self'], relationships: { x: ['self'] } });
    const source = entry('docs/source.md', {
      outgoingLinks: ['target', 'Target', 'target#Risks'],
      relationships: { owner: ['target', 'target'], parent: ['target'] },
    });
    const later = entry('docs/later.md', { relationships: { owner: ['target'] } });
    const vault = [later, target, self, source];
    expect(via(backlinksFor(target, vault))).toEqual([
      ['docs/later.md', 'owner'],
      ['docs/source.md', 'body'],
      ['docs/source.md', 'owner'],
      ['docs/source.md', 'parent'],
    ]);
    expect(backlinksFor(self, vault)).toEqual([]);
  });

  it('answers as the scan per note it replaced', () => {
    // The pre-index rule, kept here as the reference.
    const scan = (target: Entry, vault: Entry[]) => {
      const out: string[][] = [];
      for (const other of vault) {
        if (other.path === target.path) continue;
        if (other.outgoingLinks.some((t) => resolveTarget(t, vault)?.path === target.path)) {
          out.push([other.path, 'body']);
        }
        for (const [field, targets] of Object.entries(other.relationships)) {
          if (targets.some((t) => resolveTarget(t, vault)?.path === target.path)) {
            out.push([other.path, field]);
          }
        }
      }
      return out;
    };
    const names = ['a', 'b', 'c', 'Title c', 'd#Risks', 'nowhere', 'k-1'];
    const vault = Array.from({ length: 24 }, (_, i) =>
      entry(`f${i % 3}/${'abcd'[i % 4]}${i >= 4 ? i : ''}.md`, {
        title: i === 2 ? 'Title c' : `T${i}`,
        properties: i === 5 ? { key: 'K-1' } : {},
        outgoingLinks: [names[i % 7], names[(i * 3) % 7]],
        relationships: { up: [names[(i + 2) % 7]], side: [names[(i * 5) % 7], names[i % 7]] },
      }),
    );
    for (const note of vault)
      expect(via(backlinksFor(note, vault)), note.path).toEqual(scan(note, vault));
  });

  it('reads a 2,000-note vault at most 3N times for every note’s backlinks', () => {
    const N = 2000;
    const notes = Array.from({ length: N }, (_, i) =>
      entry(`n/note-${i}.md`, {
        outgoingLinks: [`note-${(i + 1) % N}`, `note-${(i + 7) % N}`],
        relationships: { parent: [`note-${Math.floor(i / 2)}`] },
      }),
    );
    const { array, reads } = counted(notes);
    let total = 0;
    for (const note of notes) total += backlinksFor(note, array).length;
    expect(total).toBeGreaterThan(N);
    expect(reads()).toBeLessThanOrEqual(3 * N);
  });
});
