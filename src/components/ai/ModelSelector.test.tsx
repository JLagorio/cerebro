// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLayers } from '@/components/ui/layers';
import { ModelSelector, type ModelSelectorChoice, type ModelSelectorProps } from './ModelSelector';

/**
 * Model Selector (M91.8): one trigger and one panel holding the Model and
 * Effort radio groups, which stay open through a pick, a free-text Other
 * model, and open state the caller holds.
 */

afterEach(() => {
  cleanup();
  resetLayers();
});

const MODELS: ModelSelectorChoice[] = [
  { value: '', label: 'Claude Code default', testId: 'run-model-default' },
  { value: 'opus', label: 'Opus', testId: 'run-model-opus' },
  { value: 'sonnet', label: 'Sonnet', testId: 'run-model-sonnet' },
];
const EFFORTS: ModelSelectorChoice[] = [
  { value: '', label: 'Claude Code default', testId: 'run-effort-default' },
  { value: 'high', label: 'High', testId: 'run-effort-high' },
];

const words = (model: string | null, effort: string | null) =>
  [
    MODELS.find((choice) => choice.value === model)?.label ?? model ?? 'Other',
    EFFORTS.find((choice) => choice.value === effort)?.label,
  ]
    .filter(Boolean)
    .join(' · ');

/** The selector with its pick and its open state held, as the panel holds
 *  them. */
function Host({
  startOpen = false,
  onModel = () => undefined,
  onEffort = () => undefined,
  ...rest
}: Partial<ModelSelectorProps> & {
  startOpen?: boolean;
  onModel?: (value: string) => void;
  onEffort?: (value: string) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [model, setModel] = useState<string | null>('');
  const [effort, setEffort] = useState<string | null>('');
  return (
    <ModelSelector
      testId="run-options"
      label={words(model, effort)}
      models={MODELS}
      model={model}
      onModelChange={(value) => {
        onModel(value);
        setModel(value);
      }}
      efforts={EFFORTS}
      effort={effort}
      onEffortChange={(value) => {
        onEffort(value);
        setEffort(value);
      }}
      open={open}
      onOpenChange={setOpen}
      {...rest}
    />
  );
}

const trigger = () => screen.getByTestId('run-options');

describe('ModelSelector', () => {
  it('names its trigger with the pick, and opens and closes on it', () => {
    render(<Host />);
    expect(
      screen.getByRole('button', {
        name: 'Model and effort: Claude Code default · Claude Code default',
      }),
    ).toBe(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Model and effort' })).toBeTruthy();
    fireEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('holds Model and Effort as radio groups that stay open through each pick', () => {
    const onModel = vi.fn();
    const onEffort = vi.fn();
    render(<Host startOpen onModel={onModel} onEffort={onEffort} />);
    const dialog = screen.getByRole('dialog', { name: 'Model and effort' });
    const model = within(dialog).getByRole('radiogroup', { name: 'Model' });
    const effort = within(dialog).getByRole('radiogroup', { name: 'Effort' });
    expect(
      within(model)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Claude Code default', 'Opus', 'Sonnet']);
    expect(
      (within(model).getByRole('radio', { name: 'Claude Code default' }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    fireEvent.click(screen.getByTestId('run-model-opus'));
    expect(onModel).toHaveBeenLastCalledWith('opus');
    fireEvent.click(screen.getByTestId('run-effort-high'));
    expect(onEffort).toHaveBeenLastCalledWith('high');

    // Still open, both picks checked, and the trigger reads them.
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((within(model).getByRole('radio', { name: 'Opus' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((within(effort).getByRole('radio', { name: 'High' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(trigger().getAttribute('aria-label')).toBe('Model and effort: Opus · High');
    expect(screen.getByTestId('run-model-opus').hasAttribute('data-checked')).toBe(true);
  });

  it('closes on Escape, through the layer stack', () => {
    render(<Host startOpen />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('takes the keyboard into the panel when it opens', () => {
    render(<Host />);
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLInputElement).type).toBe('radio');
  });

  it('uses an Other model only when the caller accepts its name, by Use or by Enter', () => {
    const onUse = vi.fn();
    render(
      <Host
        startOpen
        other={{
          defaultValue: '',
          validate: (name) => (name.startsWith('-') ? `model "${name}" is not a model name` : null),
          onUse,
          testId: 'run-model-other',
          useTestId: 'run-model-other-use',
        }}
      />,
    );
    const field = screen.getByTestId('run-model-other') as HTMLInputElement;
    const use = screen.getByTestId('run-model-other-use') as HTMLButtonElement;
    expect(field.getAttribute('aria-label')).toBe('Other model');
    expect(use.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '-x' } });
    expect(use.disabled).toBe(true);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('model "-x" is not a model name')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onUse).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '  claude-opus-5-5[1m]  ' } });
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    expect(onUse).toHaveBeenLastCalledWith('claude-opus-5-5[1m]');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onUse).toHaveBeenCalledTimes(2);
    // Neither is a submit: the panel holds no form for anything to catch.
    expect(screen.getByRole('dialog').querySelector('form')).toBeNull();
  });

  it('shows a note above the groups, and its glyph alone when compact', () => {
    render(
      <Host
        startOpen
        appearance="icon"
        note={<span data-testid="turn-model">Last answered by claude-sonnet-4-5</span>}
      />,
    );
    expect(screen.getByTestId('turn-model').textContent).toBe('Last answered by claude-sonnet-4-5');
    expect(trigger().textContent).toBe('');
    expect(trigger().getAttribute('title')).toBe(
      'Model and effort: Claude Code default · Claude Code default',
    );
  });

  it('opens nothing while disabled', () => {
    const onOpenChange = vi.fn();
    render(
      <ModelSelector
        label="Opus"
        models={MODELS}
        model="opus"
        onModelChange={vi.fn()}
        efforts={EFFORTS}
        effort={null}
        onEffortChange={vi.fn()}
        open={false}
        onOpenChange={onOpenChange}
        disabled
      />,
    );
    const button = screen.getByRole('button', { name: 'Model and effort: Opus' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
