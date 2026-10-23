// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from '@/components/ui/Icon';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from './Item';

afterEach(cleanup);

describe('Item', () => {
  it('keeps shadcn’s anatomy', () => {
    render(
      <Item variant="outline" size="sm" data-testid="item">
        <ItemHeader>Sources</ItemHeader>
        <ItemMedia variant="icon">
          <Icon name="globe" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Install Astro</ItemTitle>
          <ItemDescription>docs.astro.build</ItemDescription>
        </ItemContent>
        <ItemActions>
          <button type="button">Open</button>
        </ItemActions>
        <ItemFooter>Read 2026-10-22</ItemFooter>
      </Item>,
    );
    const item = screen.getByTestId('item');
    expect(item.className).toBe('cb-ai-item cb-ai-item-outline cb-ai-item-sm');
    expect(item.dataset.variant).toBe('outline');
    expect(item.dataset.size).toBe('sm');
    expect(item.getAttribute('role')).toBeNull();
    expect(
      [...item.querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot')),
    ).toEqual([
      'item-header',
      'item-media',
      'item-content',
      'item-title',
      'item-description',
      'item-actions',
      'item-footer',
    ]);
    expect(screen.getByText('docs.astro.build').tagName).toBe('P');
    expect(item.querySelector('[data-slot="item-media"]')?.className).toBe(
      'cb-ai-item-media cb-ai-item-media-icon',
    );
  });

  it('a default item draws no variant or size class', () => {
    render(<Item data-testid="item">Plain</Item>);
    expect(screen.getByTestId('item').className).toBe('cb-ai-item');
  });

  it('in a group, its items are a list’s items and its separators are not read', () => {
    render(
      <ItemGroup>
        <Item>First</Item>
        <ItemSeparator data-testid="rule" />
        <Item>Second</Item>
      </ItemGroup>,
    );
    const list = screen.getByRole('list');
    expect(list.dataset.slot).toBe('item-group');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'First',
      'Second',
    ]);
    expect(screen.getByTestId('rule').getAttribute('aria-hidden')).toBe('true');
  });

  it('draws as the element it is given, and then leaves its role alone', () => {
    render(
      <ItemGroup>
        <Item render={<a href="https://pnpm.io/cli/create" />} variant="muted">
          pnpm create
        </Item>
      </ItemGroup>,
    );
    const link = screen.getByRole('link', { name: 'pnpm create' });
    expect(link.className).toBe('cb-ai-item cb-ai-item-muted');
    expect(link.dataset.slot).toBe('item');
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
