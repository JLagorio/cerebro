// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_COPY, WriteDraftForm } from '@/agent/WriteDraftForm';
import { toolSchema } from '@/lib/policy/tools';
import { chooseOption, optionLabels } from '@/test/chooseOption';

/**
 * The editable draft (M57.4b): the form projected from create_note's schema,
 * controlled and without buttons, reporting the input, its validity and
 * whether it differs from the asked draft.
 */

afterEach(cleanup);

const DRAFT = { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' };

function form(draft: Record<string, unknown> = DRAFT, schema: unknown = toolSchema('create_note')) {
  const onChange = vi.fn();
  render(
    <WriteDraftForm title="Create a note" schema={schema} draft={draft} onChange={onChange} />,
  );
  return onChange;
}

const field = (key: string) =>
  screen.getByTestId(`write-draft-field-${key}`) as HTMLInputElement | HTMLTextAreaElement;

describe('WriteDraftForm', () => {
  it('seeds each flat field from the draft, with no buttons of its own', () => {
    form();
    expect(field('folder').value).toBe('records/risks');
    expect(field('slug').value).toBe('vendor-delay');
    expect(field('body').value).toBe('# Vendor delay\n');
    // The one button is if_exists's select, a field: no act is the form's.
    expect(screen.getAllByRole('button')).toEqual([field('if_exists')]);
    expect(field('if_exists').getAttribute('aria-haspopup')).toBe('listbox');
    expect(screen.getByLabelText(/^slug/)).toBe(field('slug'));
  });

  it('edits the multi-line body in a text area, and short text in an input', () => {
    form();
    expect(field('body').tagName).toBe('TEXTAREA');
    expect(field('slug').tagName).toBe('INPUT');
    form({ ...DRAFT, slug: 'x'.repeat(81) });
    expect(screen.getAllByTestId('write-draft-field-slug')[1].tagName).toBe('TEXTAREA');
  });

  it('marks the required fields and shows the schema’s hint', () => {
    form();
    for (const key of ['folder', 'slug', 'body']) {
      expect(field(key).getAttribute('data-required')).toBe('true');
      expect(field(key).getAttribute('aria-required')).toBe('true');
    }
    expect(screen.getAllByTestId('write-draft-required')).toHaveLength(3);
    expect(screen.getByText('Markdown body, starting with an H1')).toBeTruthy();
  });

  it('reports an edit as the edited input, and an edit back as no edit', () => {
    const onChange = form();
    fireEvent.change(field('body'), { target: { value: '# Vendor delay risk\n' } });
    expect(onChange).toHaveBeenLastCalledWith({
      input: { ...DRAFT, body: '# Vendor delay risk\n' },
      valid: true,
      edited: true,
    });
    fireEvent.change(field('body'), { target: { value: '# Vendor delay\n' } });
    expect(onChange).toHaveBeenLastCalledWith({ input: DRAFT, valid: true, edited: false });
  });

  it('makes the flat fields read-only while the JSON is open, and the JSON wins', () => {
    const onChange = form();
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    expect(field('body').readOnly).toBe(true);
    expect(field('slug').readOnly).toBe(true);
    expect(screen.getByTestId('write-draft-readonly').textContent).toBe(DRAFT_COPY.readOnly);
    const json = screen.getByTestId('write-draft-json') as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual(DRAFT);
    const whole = { ...DRAFT, frontmatter: { status: 'open' } };
    fireEvent.change(json, { target: { value: JSON.stringify(whole) } });
    expect(onChange).toHaveBeenLastCalledWith({ input: whole, valid: true, edited: true });
    // Closing it keeps the JSON object as the draft the fields edit.
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    expect(field('body').readOnly).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith({ input: whole, valid: true, edited: true });
  });

  it('makes a value that is not a JSON object invalid', () => {
    const onChange = form();
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    const json = screen.getByTestId('write-draft-json');
    fireEvent.change(json, { target: { value: '["not", "an", "object"]' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ valid: false, edited: true }),
    );
    expect(screen.getByTestId('write-draft-json-invalid').textContent).toBe(DRAFT_COPY.notObject);
    fireEvent.change(json, { target: { value: '{ "folder": ' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ valid: false }));
    // An object of the wrong shape is invalid too, without the note.
    fireEvent.change(json, { target: { value: '{"folder": ""}' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ valid: false, edited: true }),
    );
    expect(screen.queryByTestId('write-draft-json-invalid')).toBeNull();
  });

  it('draws a checkbox, numbers and a choice, and refuses a fraction for an integer', () => {
    const schema = {
      type: 'object',
      properties: {
        done: { type: 'boolean' },
        count: { type: 'integer' },
        size: { type: 'string', enum: ['s', 'm'] },
      },
      required: [],
    };
    const onChange = form({ count: 2 }, schema);
    expect((field('done') as HTMLInputElement).type).toBe('checkbox');
    // The design system's select: a listbox button, never a native <select>.
    const size = screen.getByTestId('write-draft-field-size');
    expect(size.getAttribute('aria-haspopup')).toBe('listbox');
    expect(screen.getByRole('button', { name: 'size' })).toBe(size);
    expect(optionLabels(size)).toEqual(['—', 's', 'm']);
    fireEvent.click(field('done'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { count: 2, done: true }, valid: true }),
    );
    fireEvent.change(field('count'), { target: { value: '1.5' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ valid: false }));
    expect(field('count').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(field('count'), { target: { value: '3' } });
    chooseOption(size, 'm');
    expect(onChange).toHaveBeenLastCalledWith({
      input: { count: 3, done: true, size: 'm' },
      valid: true,
      edited: true,
    });
  });

  it('a required choice has no none to pick, and a value off its list shows as asked', () => {
    const schema = {
      type: 'object',
      properties: { size: { type: 'string', enum: ['s', 'm'] } },
      required: ['size'],
    };
    form({}, schema);
    const size = screen.getByTestId('write-draft-field-size');
    // No value yet: the trigger says so, and the list holds only choices.
    expect(size.textContent).toBe(DRAFT_COPY.none);
    expect(optionLabels(size)).toEqual(['s', 'm']);
    cleanup();
    // Rust refuses it at the answer; the form shows it rather than hiding it.
    form({ size: 'xl' }, schema);
    const asked = screen.getByTestId('write-draft-field-size');
    expect(asked.getAttribute('data-value')).toBe('xl');
    expect(asked.textContent).toBe('xl');
  });

  it('shows the agent’s text as text, never markup', () => {
    form({ ...DRAFT, body: '<b>Vendor</b> delay\n' });
    expect(field('body').value).toBe('<b>Vendor</b> delay\n');
    expect(screen.getByTestId('write-draft-form').querySelector('b')).toBeNull();
  });
});
