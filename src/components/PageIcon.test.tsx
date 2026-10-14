import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { EntryIcon, PageIconGlyph } from './PageIcon';

const ROCKET = '\u{1F680}';
const FALLBACK = { name: 'file-text' };

afterEach(() => {
  act(() => {
    useVaultStore.setState({ entries: [] });
  });
});

describe('PageIconGlyph', () => {
  it('draws an emoji as text with role img', () => {
    render(<PageIconGlyph icon={{ kind: 'emoji', text: ROCKET }} fallback={FALLBACK} />);
    expect(screen.getByRole('img', { name: ROCKET }).textContent).toBe(ROCKET);
  });

  it('draws a file as the image glyph titled with its path, and loads nothing', () => {
    const { container } = render(
      <PageIconGlyph icon={{ kind: 'file', path: 'attachments/i.png' }} fallback={FALLBACK} />,
    );
    expect(container.querySelector('[title="attachments/i.png"] [data-icon="image"]')).not.toBe(
      null,
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws a lucide name in its option colour, and a url(...) colour as neutral', () => {
    const { container, rerender } = render(
      <PageIconGlyph
        icon={{ kind: 'lucide', name: 'rocket', color: 'blue' }}
        fallback={FALLBACK}
      />,
    );
    const svg = () => container.querySelector('[data-icon="rocket"]') as SVGElement;
    expect(svg().style.color).toBe('var(--opt-blue)');
    rerender(
      <PageIconGlyph
        icon={{ kind: 'lucide', name: 'rocket', color: 'url(https://example.com/x)' }}
        fallback={FALLBACK}
      />,
    );
    expect(svg().style.color).toBe('var(--n-300)');
    expect(container.innerHTML).not.toContain('example.com');
  });

  it('draws the fallback when nothing is set', () => {
    const { container } = render(
      <PageIconGlyph icon={null} fallback={{ name: 'file-stack', color: 'var(--n-500)' }} />,
    );
    expect(container.querySelector('[data-icon="file-stack"]')).not.toBe(null);
  });
});

describe('EntryIcon', () => {
  it('given a path, follows the store', () => {
    const page = makeEntry({ path: 'notes/a.md', properties: {} });
    useVaultStore.setState({ entries: [page] });
    const { container } = render(<EntryIcon path="notes/a.md" fallback={FALLBACK} />);
    expect(container.querySelector('[data-icon="file-text"]')).not.toBe(null);
    act(() => {
      useVaultStore.setState({ entries: [{ ...page, properties: { icon: ROCKET } }] });
    });
    expect(screen.getByRole('img', { name: ROCKET })).toBeTruthy();
    expect(container.querySelector('[data-icon="file-text"]')).toBeNull();
  });

  it('given an entry, draws its icon without the store', () => {
    render(<EntryIcon entry={makeEntry({ properties: { icon: ROCKET } })} fallback={FALLBACK} />);
    expect(screen.getByRole('img', { name: ROCKET })).toBeTruthy();
  });
});
