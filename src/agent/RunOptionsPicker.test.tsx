// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunOptionsPicker, runChoiceLabel } from '@/agent/RunOptionsPicker';
import { resetLayers } from '@/components/ui/layers';
import type { RunChoice } from '@/engine/runOptions';

afterEach(() => {
  cleanup();
  resetLayers();
  vi.unstubAllGlobals();
});

/** The picker with its open state held, as the panel holds it. */
function Host({
  value,
  onChange,
  startOpen = true,
}: {
  value: RunChoice;
  onChange: (next: RunChoice) => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  return <RunOptionsPicker value={value} onChange={onChange} open={open} onOpenChange={setOpen} />;
}

/** The picker holding the pick it is given, as a conversation does. */
function Held({ start, onChange }: { start: RunChoice; onChange: (next: RunChoice) => void }) {
  const [value, setValue] = useState(start);
  return (
    <Host
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      startOpen={false}
    />
  );
}

const UNSET: RunChoice = { model: null, effort: null };
const radio = (testId: string) =>
  within(screen.getByTestId(testId)).getByRole('radio') as HTMLInputElement;

describe('RunOptionsPicker (M56.5)', () => {
  it('reads Claude Code default, or the pick in words', () => {
    expect(runChoiceLabel(UNSET)).toBe('Claude Code default');
    expect(runChoiceLabel({ model: '  ', effort: '' })).toBe('Claude Code default');
    expect(runChoiceLabel({ model: 'opus', effort: 'high' })).toBe('Opus · High');
    expect(runChoiceLabel({ model: 'claude-sonnet-5', effort: null })).toBe('claude-sonnet-5');
    expect(runChoiceLabel({ model: null, effort: 'xhigh' })).toBe('Default model · Extra high');
    render(<Host value={UNSET} onChange={vi.fn()} startOpen={false} />);
    expect(screen.getByTestId('run-options').textContent).toBe('Claude Code default');
  });

  it('opens on its button and closes on Escape', () => {
    render(<Host value={UNSET} onChange={vi.fn()} startOpen={false} />);
    expect(screen.queryByTestId('run-model-opus')).toBeNull();
    fireEvent.click(screen.getByTestId('run-options'));
    expect(screen.getByTestId('run-model-opus')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('run-model-opus')).toBeNull();
  });

  it('keeps the compact control named and distinguishes the chosen model from the last answer', () => {
    const onChange = vi.fn();
    render(
      <RunOptionsPicker
        value={{ model: 'opus', effort: 'high' }}
        onChange={onChange}
        open={true}
        onOpenChange={vi.fn()}
        appearance="icon"
        reportedModel="claude-sonnet-4-5"
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Model and effort: Opus · High' });
    expect(trigger).toBe(screen.getByTestId('run-options'));
    expect(trigger.textContent).toBe('');
    // A tab stop WebKit keeps in the Tab order.
    expect(trigger.tabIndex).toBe(0);
    expect(screen.getByTestId('turn-model').textContent).toBe('Last answered by claude-sonnet-4-5');
    fireEvent.click(screen.getByTestId('run-model-haiku'));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'haiku', effort: 'high' });
  });

  it('offers the default and the suggestions as one radio group, and checks the pick', () => {
    const onChange = vi.fn();
    render(<Host value={{ model: 'sonnet', effort: null }} onChange={onChange} />);
    const panel = screen.getByRole('dialog', { name: 'Model and effort' });
    const models = within(panel).getByRole('radiogroup', { name: 'Model' });
    expect(within(models).getAllByRole('radio')).toHaveLength(5);
    for (const id of ['default', 'fable', 'opus', 'sonnet', 'haiku']) {
      expect(screen.getByTestId(`run-model-${id}`)).toBeTruthy();
    }
    expect(radio('run-model-sonnet').checked).toBe(true);
    expect(radio('run-effort-default').checked).toBe(true);
    fireEvent.click(screen.getByTestId('run-model-opus'));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'opus', effort: null });
    fireEvent.click(screen.getByTestId('run-model-default'));
    expect(onChange).toHaveBeenLastCalledWith({ model: null, effort: null });
    // A pick never closes the panel: both groups are picked in one visit.
    expect(screen.getByRole('dialog', { name: 'Model and effort' })).toBe(panel);
  });

  it('takes Other only when it is a model name, by Use or by Enter, with no form', () => {
    const onChange = vi.fn();
    render(<Host value={UNSET} onChange={onChange} />);
    const field = screen.getByTestId('run-model-other');
    const use = screen.getByTestId('run-model-other-use') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '-x' } });
    expect(use.disabled).toBe(true);
    expect(screen.getByText(/model "-x" is not a model name/)).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'claude-opus-5-5[1m]' } });
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-opus-5-5[1m]', effort: null });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog').querySelector('form')).toBeNull();
  });

  it('holds a full model name in Other, and checks no model radio for it', () => {
    render(<Host value={{ model: 'claude-opus-5-5[1m]', effort: null }} onChange={vi.fn()} />);
    expect((screen.getByTestId('run-model-other') as HTMLInputElement).value).toBe(
      'claude-opus-5-5[1m]',
    );
    const models = screen.getByRole('radiogroup', { name: 'Model' });
    expect(
      within(models)
        .getAllByRole('radio')
        .some((r) => (r as HTMLInputElement).checked),
    ).toBe(false);
  });

  it('offers the five effort levels and the default', () => {
    const onChange = vi.fn();
    render(<Host value={{ model: 'opus', effort: null }} onChange={onChange} />);
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    for (const id of levels) expect(screen.getByTestId(`run-effort-${id}`)).toBeTruthy();
    expect(screen.getByTestId('run-effort-xhigh').textContent).toBe('Extra high');
    fireEvent.click(screen.getByTestId('run-effort-max'));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'opus', effort: 'max' });
  });

  it('is driven from the keyboard: arrows pick in a group, Tab moves on, Escape returns', async () => {
    // jsdom has no CSS.escape, which user-event calls to find an arrowed
    // radio's group; quoting is all a useId radio name needs.
    vi.stubGlobal('CSS', { escape: (name: string) => name.replace(/["\\]/g, '\\$&') });
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Held start={{ model: 'opus', effort: 'medium' }} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Model and effort: Opus · Medium' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const panel = screen.getByRole('dialog', { name: 'Model and effort' });
    // The panel takes the keyboard on the CHECKED Model radio, a radio
    // group's one Tab stop, so no key changes the pick by landing.
    expect(document.activeElement).toBe(radio('run-model-opus'));
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith({ model: 'sonnet', effort: 'medium' });
    expect(document.activeElement).toBe(radio('run-model-sonnet'));
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith({ model: 'opus', effort: 'medium' });
    expect(radio('run-model-opus').checked).toBe(true);
    // Still open: a pick by the keyboard never closes it either.
    expect(screen.getByRole('dialog', { name: 'Model and effort' })).toBe(panel);
    expect(trigger.getAttribute('aria-label')).toBe('Model and effort: Opus · Medium');
    // Tab leaves the Model group for Other, then reaches the checked Effort
    // radio, and from there wraps inside the panel instead of leaving it.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('run-model-other'));
    await user.tab();
    expect(document.activeElement).toBe(radio('run-effort-medium'));
    await user.tab();
    expect(document.activeElement).toBe(radio('run-model-opus'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(radio('run-effort-medium'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
