import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { makeEntry } from '@/test/factories';
import { FormulaConfigEditor } from './FormulaConfigEditor';

const doc = makeEntry({
  path: 'types/metric.md',
  title: 'Metric',
  type: 'Type',
  properties: {
    fields: {
      current_value: { kind: 'number' },
      target_value: { kind: 'number' },
      day: { kind: 'date' },
      gap: { kind: 'formula', formula: 'target_value - current_value' },
    },
  } as unknown as Entry['properties'],
});
const schema = buildSchema([doc]);
const def = schema.types.get('Metric')!.fields.find((field) => field.name === 'gap')!;
const setup = () => {
  const onChange = vi.fn(async () => true);
  render(<FormulaConfigEditor typeName="Metric" def={def} schema={schema} onChange={onChange} />);
  return onChange;
};

describe('the formula draft editor', () => {
  it('saves canonical keys on Enter only after a changed draft passes validation', async () => {
    const onChange = setup();
    expect((screen.getByTestId('formula-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('formula-input'), {
      target: { value: '{Target value} + current_value' },
    });
    expect(screen.getByTestId('formula-result').textContent).toBe('Returns a number');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('formula-input'), { key: 'Enter' });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ formula: 'target_value + current_value' }),
    );
  });
  it('does not save unknown fields, cycles or unfinished formulas', () => {
    const onChange = setup();
    for (const formula of ['missing + 1', 'gap + 1', 'target_value +']) {
      fireEvent.change(screen.getByTestId('formula-input'), { target: { value: formula } });
      expect((screen.getByTestId('formula-save') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.keyDown(screen.getByTestId('formula-input'), { key: 'Enter' });
    }
    expect(onChange).not.toHaveBeenCalled();
  });
  it('reverts on Escape without closing its host and inserts a field at the caret', () => {
    setup();
    const input = screen.getByTestId('formula-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'day + 2' } });
    expect(screen.getByTestId('formula-result').textContent).toBe('Returns a date');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('target_value - current_value');
    input.setSelectionRange(0, input.value.length);
    fireEvent.click(screen.getByTestId('formula-field-target_value'));
    expect(input.value).toBe('target_value');
    expect(screen.queryByTestId('formula-field-gap')).toBeNull();
  });
  it('keeps a refused draft retryable and submits once while saving', async () => {
    let finish!: (ok: boolean) => void;
    const onChange = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<FormulaConfigEditor typeName="Metric" def={def} schema={schema} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('formula-input'), {
      target: { value: 'target_value + 2' },
    });
    fireEvent.keyDown(screen.getByTestId('formula-input'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByTestId('formula-input'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledOnce();
    finish(false);
    await waitFor(() =>
      expect((screen.getByTestId('formula-save') as HTMLButtonElement).disabled).toBe(false),
    );
    expect((screen.getByTestId('formula-input') as HTMLTextAreaElement).value).toBe(
      'target_value + 2',
    );
  });
});
