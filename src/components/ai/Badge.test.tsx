// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Badge, type BadgeVariant } from './Badge';

afterEach(cleanup);

const VARIANTS: BadgeVariant[] = [
  'default',
  'secondary',
  'destructive',
  'outline',
  'ghost',
  'link',
];

describe('Badge', () => {
  it('is a span carrying shadcn’s slot and its variant, as a class too', () => {
    render(<Badge>anthropic/claude-sonnet-4.5</Badge>);
    const badge = screen.getByText('anthropic/claude-sonnet-4.5');
    expect(badge.tagName).toBe('SPAN');
    expect(badge.dataset.slot).toBe('badge');
    expect(badge.dataset.variant).toBe('default');
    expect(badge.className).toBe('cb-ai-badge cb-ai-badge-default');
  });

  it.each(VARIANTS)('draws the %s variant', (variant) => {
    render(
      <Badge variant={variant} className="font-mono">
        3 files
      </Badge>,
    );
    const badge = screen.getByText('3 files');
    expect(badge.dataset.variant).toBe(variant);
    expect(badge.className).toBe(`cb-ai-badge cb-ai-badge-${variant} font-mono`);
  });

  it('draws as the element it is given, keeping that element’s own props', () => {
    render(
      <Badge
        variant="outline"
        className="font-mono"
        render={<a href="https://docs.example.test/" className="cb-source" />}
      >
        docs.example.test
      </Badge>,
    );
    const link = screen.getByRole('link', { name: 'docs.example.test' });
    expect(link.getAttribute('href')).toBe('https://docs.example.test/');
    expect(link.dataset.slot).toBe('badge');
    expect(link.className).toBe('cb-source cb-ai-badge cb-ai-badge-outline font-mono');
  });

  it('takes the given element’s own children over its own', () => {
    render(<Badge render={<button type="button">Retry</button>}>ignored</Badge>);
    expect(screen.getByRole('button', { name: 'Retry' }).dataset.slot).toBe('badge');
    expect(screen.queryByText('ignored')).toBeNull();
  });
});
