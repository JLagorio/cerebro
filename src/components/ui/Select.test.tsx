// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { Select } from './Select';

const options = [
  { value: '', label: 'No type' },
  { value: 'Project', label: 'Project', icon: 'folder' },
  { value: 'Person', label: 'Person', disabled: true },
  { value: 'Plan', label: 'Plan', hint: '3' },
  { value: 'Risk', label: 'Risk' },
];

function setup(props: Partial<React.ComponentProps<typeof Select>> = {}) {
  const onChange = vi.fn();
  render(
    <Select options={options} value="Project" onChange={onChange} ariaLabel="Type" {...props} />,
  );
  return { onChange, trigger: screen.getByRole('button', { name: 'Type' }) };
}

afterEach(cleanup);

describe('Select', () => {
  it('draws no native select, and names its value on a listbox button', () => {
    const { trigger } = setup();
    expect(document.querySelector('select')).toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('data-value')).toBe('Project');
    expect(trigger.textContent).toContain('Project');
  });

  it('picks with the pointer and reports only a change', () => {
    const { onChange, trigger } = setup();
    chooseOption(trigger, 'Risk');
    expect(onChange).toHaveBeenCalledWith('Risk');
    expect(screen.queryByRole('listbox')).toBeNull();
    chooseOption(trigger, 'Project');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('picks by stored value, including the empty one', () => {
    const { onChange, trigger } = setup();
    chooseOption(trigger, { value: '' });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('lists every option, in order', () => {
    const { trigger } = setup();
    expect(optionLabels(trigger)).toEqual(['No type', 'Project', 'Person', 'Plan', 'Risk']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('never picks a disabled option, by pointer or by keyboard', () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Person' }));
    expect(onChange).not.toHaveBeenCalled();
    // From Project, ArrowDown skips Person and lands on Plan.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Plan');
  });

  it('opens at the current value and walks Home and End', () => {
    const { onChange, trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox', { name: 'Type' });
    const current = screen.getByRole('option', { name: /Project/ });
    expect(list.getAttribute('aria-activedescendant')).toBe(current.id);
    fireEvent.keyDown(trigger, { key: 'End' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('Risk');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Home' });
    fireEvent.keyDown(trigger, { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('typing a name opens the list at the match and changes nothing until Enter', () => {
    const { onChange, trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'r' });
    expect(onChange).not.toHaveBeenCalled();
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Risk' }).id,
    );
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Risk');
  });

  it('shows a placeholder while the value matches no option', () => {
    setup({ value: 'Gone', placeholder: 'Choose a type' });
    const trigger = screen.getByRole('button', { name: 'Type' });
    expect(trigger.textContent).toContain('Choose a type');
  });

  it('is named by a label element, and so is its list', () => {
    render(
      <>
        <label htmlFor="kind">Kind</label>
        <Select id="kind" options={options} value="Risk" onChange={vi.fn()} />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Kind' });
    expect(trigger.getAttribute('data-value')).toBe('Risk');
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox', { name: 'Kind' })).toBeTruthy();
  });

  it('leaves a chord on a closed trigger to the app, and picks with one on an open list', () => {
    const { onChange, trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'Enter', metaKey: true });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    // ⌘Enter on the open list commits the highlighted row; a form around it
    // then submits what was picked.
    fireEvent.keyDown(trigger, { key: 'Enter', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('Plan');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  /** WebKit, and so the macOS app's WKWebView, never focuses a pressed
   *  button: the click itself focuses the trigger, so the list can hand
   *  focus back to it when it closes. While open, the LIST holds focus and
   *  names its highlighted row, which a button cannot. */
  it('holds focus in the open list, and gives it back to the trigger', () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox', { name: 'Type' });
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: /Project/ }).id,
    );
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Risk');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('hands Tab back to the trigger, so focus moves on from the select', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the keymap off the open list too', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox').getAttribute('data-key-claim')).toBe('typing');
  });

  it('keeps its keys from the keymap, as a native select did', () => {
    const { trigger } = setup();
    expect(trigger.closest('[data-key-claim]')?.getAttribute('data-key-claim')).toBe('typing');
  });

  it('says its value to a screen reader when a label names it', () => {
    const { trigger } = setup();
    const described = document.getElementById(trigger.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Project');
  });

  /** A list scrolled under a resting pointer gets mouse events at the same
   *  coordinates; they must not move a highlight the keyboard put there. */
  it('moves the highlight only when the pointer really moves', () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    const plan = screen.getByRole('option', { name: /Plan/ });
    const risk = screen.getByRole('option', { name: 'Risk' });
    fireEvent.mouseMove(plan, { clientX: 40, clientY: 40 });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    // The list scrolled; Risk slid under the same pointer position.
    fireEvent.mouseMove(plan, { clientX: 40, clientY: 40 });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('Risk');
    fireEvent.click(trigger);
    fireEvent.mouseMove(risk, { clientX: 40, clientY: 41 });
    fireEvent.mouseMove(screen.getByRole('option', { name: /Plan/ }), { clientX: 40, clientY: 70 });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('Plan');
  });

  it('stays shut while disabled', () => {
    const { trigger } = setup({ disabled: true });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('draws no search field unless it is searchable', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.querySelector('.cb-select-search')).toBeNull();
  });

  it("tints an option's icon with its colour, in the list and on the trigger", () => {
    setup({
      value: 'Risk',
      options: [
        { value: '', label: 'No type', icon: 'file-text' },
        { value: 'Risk', label: 'Risk', icon: 'triangle-alert', color: 'rgb(222, 59, 78)' },
      ],
    });
    const trigger = screen.getByRole('button', { name: 'Type' });
    const triggerIcon = trigger.querySelector<SVGElement>('.cb-select-icon');
    expect(triggerIcon?.style.color).toBe('rgb(222, 59, 78)');
    fireEvent.click(trigger);
    const icon = (name: string) =>
      screen.getByRole('option', { name }).querySelector<SVGElement>('.cb-select-icon');
    expect(icon('Risk')?.style.color).toBe('rgb(222, 59, 78)');
    // No colour of its own: the list's muted default.
    expect(icon('No type')?.style.color).toBe('');
  });
});

describe('Select, searchable', () => {
  const types = [
    { value: '', label: 'No type', icon: 'file-text' },
    { value: 'Key result', label: 'Key result', icon: 'target', color: 'rgb(31, 157, 97)' },
    { value: 'Objective', label: 'Objective', icon: 'flag', color: 'rgb(217, 119, 6)' },
    { value: 'Person', label: 'Person', icon: 'user', disabled: true },
    { value: 'Project', label: 'Project', icon: 'folder', hint: 'work' },
    { value: 'Risk', label: 'Risk', icon: 'triangle-alert' },
  ];

  function open(props: Partial<React.ComponentProps<typeof Select>> = {}) {
    const result = setup({ options: types, value: 'Risk', searchable: true, ...props });
    fireEvent.click(result.trigger);
    return { ...result, search: screen.getByRole('combobox', { name: 'Type' }) };
  }
  const typeInto = (search: HTMLElement, text: string) =>
    fireEvent.change(search, { target: { value: text } });

  it('opens on a search field that holds focus, as the combobox over the listbox', () => {
    const { trigger, search } = open({ searchPlaceholder: 'Search types…' });
    const list = screen.getByRole('listbox', { name: 'Type' });
    const current = screen.getByRole('option', { name: 'Risk' });
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute('placeholder')).toBe('Search types…');
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(search.getAttribute('aria-autocomplete')).toBe('list');
    expect(search.getAttribute('aria-controls')).toBe(list.id);
    expect(trigger.getAttribute('aria-controls')).toBe(list.id);
    expect(search.getAttribute('aria-activedescendant')).toBe(current.id);
    // The list is not a second focus stop: the field names its row.
    expect(list.getAttribute('aria-activedescendant')).toBeNull();
    expect(current.getAttribute('aria-selected')).toBe('true');
    expect(current.querySelector('.cb-select-check')).toBeTruthy();
    expect(optionLabels(trigger)).toEqual(types.map((t) => t.label));
  });

  it('filters by label without regard to case, best match first, and by hint', () => {
    const { trigger, search } = open();
    typeInto(search, 'R');
    // Risk starts with it, a word of Key result does, the rest hold it.
    expect(optionLabels(trigger)).toEqual(['Risk', 'Key result', 'Person', 'Project']);
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Risk' }).id,
    );
    typeInto(search, 'WORK');
    expect(optionLabels(trigger)).toEqual(['Project']);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says No matches when nothing answers, and Enter then picks nothing', () => {
    const { onChange, trigger, search } = open();
    typeInto(search, 'zz');
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('No matches');
    expect(search.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('walks what the search left with the arrows, past a disabled row, and Enter picks', () => {
    const { onChange, trigger, search } = open();
    typeInto(search, 'p');
    // Person and Project start with it; No type holds it. Person is disabled.
    expect(optionLabels(trigger)).toEqual(['Person', 'Project', 'No type']);
    const active = () => search.getAttribute('aria-activedescendant');
    const row = (name: string) => screen.getByRole('option', { name: new RegExp(name) }).id;
    expect(active()).toBe(row('Project'));
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe(row('No type'));
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(active()).toBe(row('Project'));
    fireEvent.keyDown(search, { key: 'PageDown' });
    expect(active()).toBe(row('No type'));
    fireEvent.keyDown(search, { key: 'PageUp' });
    expect(active()).toBe(row('Project'));
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Project');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves Space, Home and End to the field', () => {
    const { onChange, search } = open();
    // fireEvent returns false when a handler prevented the default.
    expect(fireEvent.keyDown(search, { key: ' ' })).toBe(true);
    expect(fireEvent.keyDown(search, { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(search, { key: 'End' })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Risk' }).id,
    );
  });

  it('highlights the current value again when the search is cleared', () => {
    const { search } = open();
    typeInto(search, 'obj');
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Objective' }).id,
    );
    typeInto(search, '');
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Risk' }).id,
    );
  });

  it('closes on Escape and gives focus back to the trigger, picking nothing', () => {
    const { onChange, trigger, search } = open();
    typeInto(search, 'obj');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
    // It opens again unsearched.
    fireEvent.click(trigger);
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
  });

  it('hands Tab back to the trigger, so focus moves on from the select', () => {
    const { onChange, trigger, search } = open();
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens searched for a key typed on the closed trigger, and changes nothing until Enter', () => {
    const { onChange, trigger } = setup({ options: types, value: 'Risk', searchable: true });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'o' });
    const search = screen.getByRole<HTMLInputElement>('combobox', { name: 'Type' });
    expect(search.value).toBe('o');
    expect(document.activeElement).toBe(search);
    expect(search.selectionStart).toBe(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Objective' }).id,
    );
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Objective');
  });

  it('gives the search a key typed while focus is elsewhere in the open list', () => {
    const { trigger, search } = open();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'k' });
    expect((search as HTMLInputElement).value).toBe('k');
    expect(document.activeElement).toBe(search);
    // Project only by its hint, so last.
    expect(optionLabels(trigger)).toEqual(['Key result', 'Risk', 'Project']);
  });

  it('keeps focus in the field through a press on the list, its padding or No matches', () => {
    const { search } = open();
    typeInto(search, 'pro');
    // fireEvent returns false when a handler prevented the default.
    expect(fireEvent.mouseDown(screen.getByRole('listbox'))).toBe(false);
    expect(fireEvent.mouseDown(search.parentElement as HTMLElement)).toBe(false);
    typeInto(search, 'zz');
    expect(fireEvent.mouseDown(screen.getByRole('status'))).toBe(false);
    // The field's own press still places its caret.
    expect(fireEvent.mouseDown(search)).toBe(true);
    expect(document.activeElement).toBe(search);
  });

  it('picks with the pointer, and the shared helpers still choose by label', () => {
    const { onChange, trigger, search } = open();
    typeInto(search, 'key');
    fireEvent.click(screen.getByRole('option', { name: 'Key result' }));
    expect(onChange).toHaveBeenCalledWith('Key result');
    chooseOption(trigger, 'Objective');
    expect(onChange).toHaveBeenLastCalledWith('Objective');
  });

  it('lists at least 240px wide, and never narrower than its trigger', () => {
    const { search } = open();
    const combo = search.closest<HTMLElement>('.cb-select-combo');
    expect(combo?.style.minWidth).toBe('240px');
    expect(combo?.style.maxWidth).toBe('360px');
    cleanup();
    const wide = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const width = this.classList.contains('cb-select') ? 400 : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 0,
          right: width,
          width,
          height: 0,
        } as DOMRect;
      });
    try {
      const again = open();
      const wider = again.search.closest<HTMLElement>('.cb-select-combo');
      expect(wider?.style.minWidth).toBe('400px');
      expect(wider?.style.maxWidth).toBe('400px');
    } finally {
      wide.mockRestore();
    }
  });
});
