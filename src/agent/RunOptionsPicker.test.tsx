// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunOptionsPicker, runChoiceLabel } from '@/agent/RunOptionsPicker';
import type { RunChoice } from '@/engine/runOptions';

afterEach(cleanup);

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

const UNSET: RunChoice = { model: null, effort: null };

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

  it('offers the default and the suggestions, and marks the pick', () => {
    const onChange = vi.fn();
    render(<Host value={{ model: 'sonnet', effort: null }} onChange={onChange} />);
    for (const id of ['default', 'fable', 'opus', 'sonnet', 'haiku']) {
      expect(screen.getByTestId(`run-model-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('run-model-sonnet').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('run-effort-default').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('run-model-opus'));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'opus', effort: null });
    fireEvent.click(screen.getByTestId('run-model-default'));
    expect(onChange).toHaveBeenLastCalledWith({ model: null, effort: null });
  });

  it('takes Other only when it is a model name', () => {
    const onChange = vi.fn();
    render(<Host value={UNSET} onChange={onChange} />);
    const field = screen.getByTestId('run-model-other');
    const use = screen.getByTestId('run-model-other-use') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '-x' } });
    expect(use.disabled).toBe(true);
    expect(screen.getByText(/model "-x" is not a model name/)).toBeTruthy();
    fireEvent.submit(field);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'claude-opus-5-5[1m]' } });
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-opus-5-5[1m]', effort: null });
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
});
