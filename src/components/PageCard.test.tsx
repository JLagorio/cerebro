// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageRef } from '@/engine/pageCard';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { ConnectedPageCard, PageCardView, PICKER_LIMIT } from './PageCard';

/** The page card's faces (M55.14), over a fixed vault and over the live store. */

const ROCKET = '\u{1F680}';

const SCHEDULE = makeEntry({
  path: 'delivery/how-we-schedule.md',
  title: 'How we schedule',
  properties: { icon: ROCKET },
});
const RISKS = makeEntry({ path: 'strategy/risks.md', title: 'Risks' });
const ITEM = makeEntry({
  path: 'records/work-items/fld-4.md',
  title: 'Blank-state coaching copy',
  type: 'Work item',
  properties: { status: 'progress' },
});
const ITEM_TYPE = makeEntry({
  path: 'types/work-item.md',
  title: 'Work item',
  type: 'Type',
  properties: {
    statuses: [{ id: 'progress', label: 'In progress', group: 'active', color: '#DE8F0A' }],
    fields: { status: { kind: 'status' } },
  } as unknown as Entry['properties'],
});
const TEMPLATE = makeEntry({ path: 'templates/meeting.md', title: 'Meeting' });
const VAULT = [SCHEDULE, RISKS, ITEM, ITEM_TYPE, TEMPLATE];
const SCHEMA = buildSchema(VAULT);

function renderView(props: {
  target?: string;
  alias?: string;
  entries?: Entry[];
  onOpen?: (path: string) => void;
  onChange?: (ref: PageRef) => void;
}) {
  const entries = props.entries ?? VAULT;
  return render(
    <PageCardView
      target={props.target ?? ''}
      alias={props.alias ?? ''}
      entries={entries}
      schema={entries === VAULT ? SCHEMA : buildSchema(entries)}
      onOpen={props.onOpen ?? vi.fn()}
      onChange={props.onChange}
    />,
  );
}

const card = () => screen.getByTestId('page-card');
const options = () => screen.queryAllByTestId('page-card-option');

afterEach(cleanup);

describe('the unset card', () => {
  it('lists the pages a link may name, and filters them by title or path', () => {
    renderView({ onChange: vi.fn() });
    expect(card().getAttribute('data-state')).toBe('unset');
    const titles = () => options().map((o) => o.textContent ?? '');
    // No Type doc and no template.
    expect(titles().some((t) => t.includes('Work item') && !t.includes('fld-4'))).toBe(false);
    expect(titles().some((t) => t.includes('Meeting'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Find a page'), { target: { value: 'sched' } });
    expect(options()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Find a page'), { target: { value: 'strategy/' } });
    expect(titles()).toEqual([expect.stringContaining('Risks')]);
  });

  it('writes the picked page’s stem', () => {
    const onChange = vi.fn();
    renderView({ onChange });
    fireEvent.change(screen.getByLabelText('Find a page'), { target: { value: 'how we' } });
    fireEvent.click(options()[0]);
    expect(onChange).toHaveBeenCalledWith({ target: 'how-we-schedule', alias: '' });
  });

  it('lists fifty rows, then asks for more letters', () => {
    const many = Array.from({ length: PICKER_LIMIT + 3 }, (_, i) =>
      makeEntry({ path: `notes/n-${i}.md`, title: `Note ${i}` }),
    );
    renderView({ entries: many, onChange: vi.fn() });
    expect(options()).toHaveLength(PICKER_LIMIT);
    expect(screen.getByTestId('page-card-more').textContent).toBe('3 more — keep typing');
  });

  it('offers no picker when the card may not be written', () => {
    renderView({});
    expect(screen.queryByLabelText('Find a page')).toBeNull();
    expect(card().textContent).toBe('No page chosen');
  });
});

describe('the resolved card', () => {
  it('shows the page’s own icon and title, and opens it', () => {
    const onOpen = vi.fn();
    renderView({ target: 'how-we-schedule', onOpen, onChange: vi.fn() });
    expect(card().getAttribute('data-state')).toBe('resolved');
    expect(within(card()).getByRole('img', { name: ROCKET })).toBeTruthy();
    expect(screen.getByTestId('page-card-title').textContent).toBe('How we schedule');
    expect(card().textContent).toContain('delivery/how-we-schedule.md');
    // A doc has no status.
    expect(screen.queryByTestId('page-card-status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('delivery/how-we-schedule.md');
  });

  it('shows a record’s type and its status label', () => {
    renderView({ target: 'fld-4' });
    expect(card().textContent).toContain('Work item');
    expect(screen.getByTestId('page-card-status').textContent).toBe('In progress');
  });

  it('reaches the page of a section link, and shows an alias as written', () => {
    renderView({ target: 'risks#Top', alias: 'The risks' });
    expect(card().getAttribute('data-state')).toBe('resolved');
    expect(screen.getByTestId('page-card-title').textContent).toBe('The risks');
  });

  it('is read-only and holds no editor', () => {
    renderView({ target: 'how-we-schedule', onChange: vi.fn() });
    expect(card().getAttribute('contenteditable')).toBe('false');
    expect(card().querySelector('[data-testid="markdown-editor"], .bn-editor')).toBeNull();
    expect(card().querySelector('[contenteditable="true"]')).toBeNull();
  });
});

describe('the missing card', () => {
  it('names the pointer and never rewrites it on render', () => {
    const onChange = vi.fn();
    renderView({ target: 'no-such-page', onChange });
    expect(card().getAttribute('data-state')).toBe('missing');
    expect(card().textContent).toContain('No page named “no-such-page”');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rewrites the pointer only when a page is picked', () => {
    const onChange = vi.fn();
    renderView({ target: 'no-such-page', onChange });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a page' }));
    fireEvent.keyDown(screen.getByLabelText('Find a page'), { key: 'Escape' });
    expect(card().textContent).toContain('No page named');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a page' }));
    fireEvent.change(screen.getByLabelText('Find a page'), { target: { value: 'risks' } });
    fireEvent.click(options()[0]);
    expect(onChange).toHaveBeenCalledWith({ target: 'risks', alias: '' });
  });

  it('offers no Choose button when the card may not be written', () => {
    renderView({ target: 'no-such-page' });
    expect(screen.queryByRole('button', { name: 'Choose a page' })).toBeNull();
  });
});

describe('ConnectedPageCard', () => {
  afterEach(() => {
    cleanup();
    useVaultStore.setState({ entries: [] });
  });

  it('follows the store: a renamed target shows its new title', () => {
    act(() => useVaultStore.setState({ entries: VAULT }));
    render(<ConnectedPageCard target="risks" alias="" />);
    expect(screen.getByTestId('page-card-title').textContent).toBe('Risks');
    act(() =>
      useVaultStore.setState({
        entries: VAULT.map((e) => (e === RISKS ? { ...e, title: 'Known risks' } : e)),
      }),
    );
    expect(screen.getByTestId('page-card-title').textContent).toBe('Known risks');
  });
});
