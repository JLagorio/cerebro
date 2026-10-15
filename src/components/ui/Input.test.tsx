import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Input } from './Input';
afterEach(cleanup);
it('passes combobox semantics to the actual input', () => {
  render(
    <Input
      id="search"
      role="combobox"
      ariaLabel="Search"
      ariaExpanded
      ariaControls="results"
      ariaAutocomplete="list"
      ariaActivedescendant="option-2"
    />,
  );
  const input = screen.getByRole('combobox');
  expect(input.tagName).toBe('INPUT');
  for (const [key, value] of Object.entries({
    id: 'search',
    'aria-expanded': 'true',
    'aria-controls': 'results',
    'aria-autocomplete': 'list',
    'aria-activedescendant': 'option-2',
  }))
    expect(input.getAttribute(key)).toBe(value);
});
