import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardSettings, showsCards } from '@/views/BoardSettings';
import { VIEW_TYPES } from '@/engine/types';
import type { Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'board',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }],
};

afterEach(cleanup);

describe('showsCards', () => {
  // The point of the table is that a NEW view kind cannot inherit a default
  // and ship with a settings panel that silently has no card section — the
  // failure mode M16.3 removed from the rest of the kind capabilities.
  it('answers for every view kind, and only the board draws cards today', () => {
    expect(VIEW_TYPES.filter((t) => showsCards(t))).toEqual(['board']);
  });
});

describe('BoardSettings', () => {
  it('defaults to medium cards and no preview without writing either key', () => {
    render(<BoardSettings presentation={presentation} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('Medium')).toBeTruthy();
    expect(screen.getByDisplayValue('None')).toBeTruthy();
    expect(presentation.cardSize).toBeUndefined();
    expect(presentation.cardPreview).toBeUndefined();
  });

  it('writes the card size onto the presentation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardSettings presentation={presentation} onChange={onChange} />);
    await user.selectOptions(screen.getByDisplayValue('Medium'), 'large');
    expect(onChange).toHaveBeenCalledWith({ ...presentation, cardSize: 'large' });
  });

  it('writes the card preview onto the presentation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardSettings presentation={presentation} onChange={onChange} />);
    await user.selectOptions(screen.getByDisplayValue('None'), 'content');
    expect(onChange).toHaveBeenCalledWith({ ...presentation, cardPreview: 'content' });
  });

  // Notion offers "Page cover" here. We have no per-record cover — `Entry`
  // carries a per-TYPE icon and nothing else — so offering it would be a menu
  // row that changes nothing, which is what this milestone is deleting.
  it('does not offer a page cover it cannot render', () => {
    render(<BoardSettings presentation={presentation} onChange={vi.fn()} />);
    expect(screen.queryByRole('option', { name: /cover/i })).toBeNull();
  });

  it('deletes colorColumns rather than storing a false when switched back off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <BoardSettings presentation={{ ...presentation, colorColumns: true }} onChange={onChange} />,
    );
    await user.click(screen.getByRole('switch', { name: 'Color columns' }));
    expect(onChange).toHaveBeenCalledWith(presentation);
    expect(Object.keys(onChange.mock.calls[0][0] as object)).not.toContain('colorColumns');
  });

  it('turns colorColumns on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardSettings presentation={presentation} onChange={onChange} />);
    await user.click(screen.getByRole('switch', { name: 'Color columns' }));
    expect(onChange).toHaveBeenCalledWith({ ...presentation, colorColumns: true });
  });
});
