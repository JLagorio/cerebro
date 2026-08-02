import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ICON_ALIASES, Icon, resolveIcon } from '@/components/ui/Icon';

afterEach(cleanup);

const paths = (el: Element | null) => el?.querySelectorAll('path,rect,circle,line,polyline').length;

describe('Icon', () => {
  it('renders a known lucide icon', () => {
    const { container } = render(<Icon name="target" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(paths(svg)).toBeGreaterThan(0);
  });

  // The whole reason "Work item" had an invisible glyph everywhere: lucide
  // renamed CheckSquare to SquareCheck and vaults still say `check-square`.
  it('resolves a renamed lucide icon through the alias table', () => {
    expect(resolveIcon('check-square').Comp).toBe(resolveIcon('square-check').Comp);
    expect(resolveIcon('alert-triangle').Comp).toBe(resolveIcon('triangle-alert').Comp);
    expect(resolveIcon('x-circle').Comp).toBe(resolveIcon('circle-x').Comp);
  });

  it('draws a visible placeholder instead of an empty svg for an unknown name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(<Icon name="definitely-not-an-icon" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      // The old behaviour was a <svg> with no children at all.
      expect(paths(svg)).toBeGreaterThan(0);
      expect(svg?.getAttribute('data-unknown-icon')).toBe('definitely-not-an-icon');
    } finally {
      warn.mockRestore();
    }
  });

  // Lucide renames icons and drops the old key from its `icons` registry, so an
  // alias target rots silently: `help-circle -> circle-help` still looked
  // correct in the table long after `circle-help` itself became
  // `circle-question-mark`, and every unverified TrustChip drew a placeholder.
  it('every alias points at a name lucide still ships', () => {
    for (const [from, to] of Object.entries(ICON_ALIASES)) {
      expect(resolveIcon(to).Comp, `alias ${from} -> ${to} resolves to nothing`).not.toBeNull();
    }
  });

  // The same rot hits call sites directly. Sweeping source is the only check
  // that scales: a name is a string, so nothing else fails when lucide drops it.
  it('every icon name written in src/ resolves', () => {
    // cwd is the repo root under vitest; import.meta.url is project-relative.
    const root = join(process.cwd(), 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) return walk(p);
        return /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [p] : [];
      });
    const patterns = [
      // <Icon name="x" /> — anchored on the tag so form fields never match.
      /<Icon\b[^>]*?\sname=["']([a-z][a-z0-9-]*)["']/g,
      // icon="x" on IconButton and friends; icon: 'x' in config tables.
      /\bicon=["']([a-z][a-z0-9-]*)["']/g,
      /\bicon:\s*['"]([a-z][a-z0-9-]*)['"]/g,
    ];
    const bad: string[] = [];
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const [, name] of text.matchAll(pattern)) {
          if (resolveIcon(name).Comp === null) bad.push(`${file.slice(root.length)}: "${name}"`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('warns once per unknown name in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<Icon name="another-missing-icon" />);
      render(<Icon name="another-missing-icon" />);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('another-missing-icon');
    } finally {
      warn.mockRestore();
    }
  });
});
