import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProductHelp } from './ProductHelp';
import { helpTopic } from './productHelpCatalog';

afterEach(cleanup);
describe('product help', () => {
  it('opens one guide on demand and allows keyboard selection and return', async () => {
    const user = userEvent.setup();
    render(<ProductHelp />);
    expect(screen.queryByRole('article')).toBeNull();
    await user.tab();
    await user.keyboard('{Enter}');
    const choice = screen.getByRole('button', { name: 'Review knowledge' });
    expect(document.activeElement).toBe(choice);
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article').textContent).toContain('Verify');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Review knowledge' }));
    await user.click(screen.getByRole('button', { name: 'All guides' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review knowledge' }));
  });
  it('unknown retrieval is unavailable, not a fallback to another topic', () => {
    expect(helpTopic('../private.md')).toBeNull();
    expect(helpTopic('knowledge')?.appVersion).toBeTruthy();
    expect(helpTopic('knowledge')?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
