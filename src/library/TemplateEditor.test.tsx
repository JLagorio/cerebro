import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateDraft } from '@/engine/libraryDraft';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { TemplateEditor } from './TemplateEditor';

/** The template editor's stamp (M18): picked from the vault's types. */

afterEach(cleanup);

function editor(draft: Partial<TemplateDraft> = {}, types = ['Risk', 'Work item']) {
  const onChange = vi.fn();
  const full: TemplateDraft = { type: '', body: '', fill: '', ...draft };
  render(<TemplateEditor draft={full} types={types} onChange={onChange} />);
  return { onChange, full };
}

describe('TemplateEditor', () => {
  it('picks its type from the vault, named by its label, a document by default', () => {
    const { onChange, full } = editor();
    const type = screen.getByRole('button', { name: 'Type' });
    expect(type.textContent).toBe('A document');
    expect(optionLabels(type)).toEqual(['A document', 'Risk', 'Work item']);
    chooseOption(type, 'Risk');
    expect(onChange).toHaveBeenCalledWith({ ...full, type: 'Risk' });
  });

  it('a type the vault no longer declares still reads as itself', () => {
    editor({ type: 'Retired' });
    const type = screen.getByRole('button', { name: 'Type' });
    expect(type.getAttribute('data-value')).toBe('Retired');
    expect(type.textContent).toBe('Retired');
  });
});
