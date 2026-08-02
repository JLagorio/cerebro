import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ChatInput } from './ChatInput';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

const skillEntry = (title: string) => {
  const stem = title.toLowerCase().replace(/\s+/g, '-');
  return makeEntry({
    path: `records/skills/${stem}.md`,
    filename: `${stem}.md`,
    folder: 'records/skills',
    title,
    type: 'Skill',
    properties: { description: `${title} description` },
    snippet: 'instructions',
  });
};

function Harness({ onSubmit = () => undefined }: { onSubmit?: () => void }) {
  const [value, setValue] = useState('');
  return <ChatInput value={value} onChange={setValue} onSubmit={onSubmit} />;
}

const box = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;

describe('ChatInput slash completion (M13.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      entries: [skillEntry('Weekly review'), skillEntry('Risk sweep')],
    });
  });

  it('opens on /, narrows, completes, and CLOSES — Enter then sends', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(box(), { target: { value: '/' } });
    expect(screen.getByTestId('skill-menu')).toBeTruthy();
    fireEvent.change(box(), { target: { value: '/we' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('/weekly-review ');
    // The review's second major: the menu used to stay open on a stale caret
    // and swallow Enter-to-send forever. Closed means the next Enter submits.
    expect(screen.queryByTestId('skill-menu')).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('one space makes it prose: no menu, and Escape closes via the same rule', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '/we' } });
    expect(screen.getByTestId('skill-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('/we ');
    expect(screen.queryByTestId('skill-menu')).toBeNull();
  });

  it('a highlight arrowed in the slash menu cannot leak into the wikilink menu', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '/' } });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Escape' });
    fireEvent.change(box(), { target: { value: '[[risk sweep' } });
    // The review's first major: with the stale index this threw on Enter when
    // the wikilink menu had fewer rows than the slash menu had.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('[[Risk sweep]]');
  });
});
