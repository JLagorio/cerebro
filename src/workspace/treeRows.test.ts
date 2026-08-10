import { describe, expect, it } from 'vitest';
import type { DirEntry, Root } from '@/engine/roots';
import { flattenTree } from './treeRows';

const root = (id: string, label: string): Root => ({
  id,
  path: `/repos/${label}`,
  label,
  alias: label,
  color: null,
  caps: { knowledge: false, git: true, writable: true },
});

const entry = (name: string, path: string, isDir: boolean, ignored = false): DirEntry => ({
  name,
  path,
  isDir,
  size: 0,
  ignored,
});

describe('flattenTree', () => {
  it('shows a row per root when nothing is expanded', () => {
    const rows = flattenTree([root('r1', 'alpha'), root('r2', 'beta')], {}, {}, true);
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'beta']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(rows.every((r) => r.isRoot)).toBe(true);
  });

  it('splices children in beneath an expanded root', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true },
      { 'r1 ': [entry('src', 'src', true), entry('README.md', 'README.md', false)] },
      true,
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'src', 'README.md']);
    expect(rows[1].depth).toBe(1);
  });

  it('nests a second level under an expanded directory', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true, 'r1 src': true },
      {
        'r1 ': [entry('src', 'src', true)],
        'r1 src': [entry('main.rs', 'src/main.rs', false)],
      },
      true,
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'src', 'main.rs']);
    expect(rows[2].depth).toBe(2);
  });

  it('does not descend into a collapsed directory', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true },
      {
        'r1 ': [entry('src', 'src', true)],
        'r1 src': [entry('main.rs', 'src/main.rs', false)],
      },
      true,
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'src']);
  });

  it('hides ignored entries when the toggle is off', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true },
      { 'r1 ': [entry('dist', 'dist', true, true), entry('README.md', 'README.md', false)] },
      false,
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'README.md']);
  });

  it('shows ignored entries flagged when the toggle is on', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true },
      { 'r1 ': [entry('dist', 'dist', true, true)] },
      true,
    );
    expect(rows[1].ignored).toBe(true);
  });

  it('gives every row a key unique across roots', () => {
    const rows = flattenTree(
      [root('r1', 'alpha'), root('r2', 'beta')],
      { 'r1 ': true, 'r2 ': true },
      {
        'r1 ': [entry('README.md', 'README.md', false)],
        'r2 ': [entry('README.md', 'README.md', false)],
      },
      true,
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
