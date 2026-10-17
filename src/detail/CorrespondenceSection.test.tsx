import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { CorrespondenceSection } from './CorrespondenceSection';
const open = vi.fn();
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));
const type = makeEntry({
  path: 'types/contact.md',
  title: 'Contact',
  type: 'Type',
  properties: { fields: { email: 'email' } } as never,
});
const person = makeEntry({
  path: 'people/dana.md',
  title: 'Dana',
  type: 'Contact',
  properties: { email: 'dana@acme.example' },
});
const thread = makeEntry({
  path: 'sources/mail/t.md',
  title: 'Launch',
  properties: {
    source_kind: 'thread',
    participants: ['dana@acme.example', 'me@our.example'],
    owner_addresses: ['me@our.example'],
    sent_to: ['dana@acme.example'],
    first_message_at: '2026-07-28T09:00:00Z',
    last_message_at: '2026-07-28T10:00:00Z',
    last_sent_at: '2026-07-28T09:00:00Z',
    last_from: 'dana@acme.example',
    needs_reply: true,
    message_count: 2,
  },
});
function show(entry = person, extras: Entry[] = [thread]) {
  const entries = [type, entry, ...(entry.path === person.path ? [] : [person]), ...extras];
  useVaultStore.setState({ entries, status: 'ready' });
  return render(<CorrespondenceSection entry={entry} schema={buildSchema(entries)} />);
}
beforeEach(() => open.mockReset());
afterEach(cleanup);
it('stays silent until mail is cached and never claims an undeclared email', () => {
  show(person, []);
  expect(screen.queryByTestId('correspondence-section')).toBeNull();
  cleanup();
  show({ ...person, type: null });
  expect(screen.queryByTestId('correspondence-section')).toBeNull();
});
it('states dates, waiting and thread count and opens the actual digest', () => {
  show();
  expect(screen.getByTestId('correspondence-section').textContent).toContain(
    '1 thread · waiting on you in 1',
  );
  expect(screen.getByText(/Last emailed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Launch/ }));
  expect(open).toHaveBeenCalledWith(thread.path);
});
it('names shared addresses and does not match either page', () => {
  const other = { ...person, path: 'people/other.md', title: 'Other Dana' };
  show(person, [other, thread]);
  expect(screen.getByTestId('correspondence-section').textContent).toContain(
    'Mail is not matched to either page',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Other Dana' }));
  expect(open).toHaveBeenCalledWith(other.path);
  expect(screen.queryByRole('button', { name: /Launch/ })).toBeNull();
});
it('shows owner and unmatched words instead of a zero count', () => {
  show({ ...person, path: 'people/me.md', properties: { email: 'me@our.example' } });
  expect(screen.getByText('This is you: every cached thread includes you.')).toBeTruthy();
  cleanup();
  show({ ...person, properties: { email: 'nobody@acme.example' } });
  expect(screen.getByTestId('correspondence-section').textContent).toContain(
    'No cached thread includes nobody@acme.example.',
  );
  expect(screen.getByTestId('correspondence-section').textContent).not.toContain('0 threads');
});
it('names unreadable mail and failed scans rather than pretending there is none', () => {
  show(person, [{ ...thread, parseError: 'bad YAML' }]);
  expect(screen.getByTestId('correspondence-section').getAttribute('data-state')).toBe('partial');
  expect(screen.getByText('1 cached thread could not be read.')).toBeTruthy();
  cleanup();
  const entries = [type, person];
  useVaultStore.setState({ entries, status: 'error' });
  render(<CorrespondenceSection entry={person} schema={buildSchema(entries)} />);
  expect(screen.getByTestId('section-unavailable')).toBeTruthy();
  expect(screen.queryByText(/No cached thread includes/)).toBeNull();
});
it('folds at ten rows and expands on request', () => {
  show(
    person,
    Array.from({ length: 12 }, (_, i) => ({
      ...thread,
      path: `sources/mail/t${i}.md`,
      title: `Thread ${i}`,
    })),
  );
  expect(screen.getAllByRole('button', { name: /Thread/ })).toHaveLength(10);
  fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
  expect(screen.getAllByRole('button', { name: /Thread/ })).toHaveLength(12);
});

it('heads a company by domain and explains personal and own domains', () => {
  const companyType = makeEntry({
    path: 'types/company.md',
    title: 'Organization',
    type: 'Type',
    properties: { email_domain: 'website', fields: { website: 'url' } } as never,
  });
  for (const [domain, words] of [
    ['acme.example', 'Mail with acme.example'],
    ['gmail.com', 'gmail.com is a personal mail domain, so mail is not grouped under it.'],
    ['our.example', 'our.example is your domain, so mail is not grouped under it.'],
  ]) {
    const company = makeEntry({
      path: 'companies/acme.md',
      type: 'Organization',
      properties: { website: domain },
    });
    const entries = [companyType, company, thread];
    useVaultStore.setState({ entries, status: 'ready' });
    render(<CorrespondenceSection entry={company} schema={buildSchema(entries)} />);
    expect(screen.getByTestId('correspondence-section').textContent).toContain(words);
    cleanup();
  }
});
