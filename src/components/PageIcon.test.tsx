import { seedBytes, reset as resetBytes } from '@/lib/mockBytes';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { EntryIcon, PageIconGlyph } from './PageIcon';

beforeEach(() => {
  resetBytes();
  vi.stubGlobal('IntersectionObserver', undefined);
});

const ROCKET = '\u{1F680}';
const FALLBACK = { name: 'file-text' };

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => {
    useVaultStore.setState({ entries: [] });
  });
});

describe('PageIconGlyph', () => {
  it('draws an emoji as text with role img', () => {
    render(<PageIconGlyph icon={{ kind: 'emoji', text: ROCKET }} fallback={FALLBACK} />);
    expect(screen.getByRole('img', { name: ROCKET }).textContent).toBe(ROCKET);
  });

  it('draws a file through the byte door and falls back on decode failure', async () => {
    seedBytes('0', 'attachments/i.png', { bytes: [137, 80, 78, 71, 13, 10, 26, 10] });
    const { container } = render(
      <PageIconGlyph icon={{ kind: 'file', path: 'attachments/i.png' }} fallback={FALLBACK} />,
    );
    const image = await screen.findByRole('img', { name: 'i.png' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    fireEvent.error(image);
    await waitFor(() => expect(container.querySelector('[data-icon="image"]')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
  });
  it('keeps a remote icon as a glyph without loading it', () => {
    const { container } = render(
      <PageIconGlyph
        icon={{ kind: 'file', path: 'https://example.com/i.png' }}
        fallback={FALLBACK}
      />,
    );
    expect(container.querySelector('[data-icon="image"]')).not.toBeNull();
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
