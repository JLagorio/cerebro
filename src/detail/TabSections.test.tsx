// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabSections, parseSections } from './TabSections';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

describe('parseSections (M44.5)', () => {
  it("reads the tab's list and tolerates garbage", () => {
    expect(parseSections({ spec: [{ heading: 'Goal', text: 'Ship it' }, 'junk'] }, 'spec')).toEqual(
      [{ heading: 'Goal', text: 'Ship it' }],
    );
    expect(parseSections('sideways', 'spec')).toEqual([]);
    expect(parseSections(undefined, 'spec')).toEqual([]);
    expect(parseSections({ spec: 'not-a-list' }, 'spec')).toEqual([]);
  });

  it('a section missing a field reads as empty, not dropped', () => {
    expect(parseSections({ spec: [{ heading: 'Goal' }] }, 'spec')).toEqual([
      { heading: 'Goal', text: '' },
    ]);
  });
});

describe('TabSections (M44.5)', () => {
  const patchFrontmatter = vi.fn().mockResolvedValue(true);
  beforeEach(() => {
    patchFrontmatter.mockClear();
    useVaultStore.setState({ patchFrontmatter });
  });
  afterEach(cleanup);

  const entry = makeEntry({
    path: 'items/a.md',
    type: 'Work item',
    properties: {
      _sections: { spec: [{ heading: 'Goal', text: 'Ship it' }] },
    } as never,
  });

  it("renders the tab's sections and an empty state for a bare tab", () => {
    render(<TabSections entry={entry} tabId="spec" />);
    expect(screen.getByDisplayValue('Goal')).toBeTruthy();
    expect(screen.getByDisplayValue('Ship it')).toBeTruthy();
    expect(screen.queryByTestId('sections-empty')).toBeNull();
    cleanup();
    render(<TabSections entry={entry} tabId="notes" />);
    expect(screen.getByTestId('sections-empty')).toBeTruthy();
  });

  it('adding a section patches _sections for THIS tab only', () => {
    render(<TabSections entry={entry} tabId="notes" />);
    fireEvent.click(screen.getByTestId('add-section'));
    expect(patchFrontmatter).toHaveBeenCalledWith('items/a.md', {
      _sections: {
        spec: [{ heading: 'Goal', text: 'Ship it' }],
        notes: [{ heading: '', text: '' }],
      },
    });
  });

  it('deleting the last section of the last tab deletes the key', () => {
    render(<TabSections entry={entry} tabId="spec" />);
    fireEvent.click(screen.getByLabelText('Delete section'));
    expect(patchFrontmatter).toHaveBeenCalledWith('items/a.md', { _sections: null });
  });

  it("deleting this tab's last section keeps a sibling tab's sections", () => {
    const both = makeEntry({
      path: 'items/a.md',
      type: 'Work item',
      properties: {
        _sections: {
          spec: [{ heading: 'Goal', text: 'Ship it' }],
          notes: [{ heading: 'Aside', text: 'Keep me' }],
        },
      } as never,
    });
    render(<TabSections entry={both} tabId="spec" />);
    fireEvent.click(screen.getByLabelText('Delete section'));
    expect(patchFrontmatter).toHaveBeenCalledWith('items/a.md', {
      _sections: { notes: [{ heading: 'Aside', text: 'Keep me' }] },
    });
  });

  it('a text edit commits on blur, not per keystroke', () => {
    render(<TabSections entry={entry} tabId="spec" />);
    const textarea = screen.getByDisplayValue('Ship it');
    fireEvent.change(textarea, { target: { value: 'Ship it soon' } });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(patchFrontmatter).toHaveBeenCalledWith('items/a.md', {
      _sections: { spec: [{ heading: 'Goal', text: 'Ship it soon' }] },
    });
  });

  it('a heading edit commits on blur too', () => {
    render(<TabSections entry={entry} tabId="spec" />);
    const heading = screen.getByDisplayValue('Goal');
    fireEvent.change(heading, { target: { value: 'Mission' } });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    fireEvent.blur(heading);
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(patchFrontmatter).toHaveBeenCalledWith('items/a.md', {
      _sections: { spec: [{ heading: 'Mission', text: 'Ship it' }] },
    });
  });

  it('an unchanged blur writes nothing', () => {
    render(<TabSections entry={entry} tabId="spec" />);
    fireEvent.blur(screen.getByDisplayValue('Ship it'));
    fireEvent.blur(screen.getByDisplayValue('Goal'));
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
});
