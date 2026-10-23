// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputStatus,
} from './PromptInput';

/**
 * Prompt Input (M91.8): Enter sends and Shift+Enter does not, an Enter that
 * ends an IME composition never sends, and nothing here is a form.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Composer({
  onSubmit = vi.fn(),
  onStop,
  status,
  disabled,
  onKeyDown,
  children,
}: {
  onSubmit?: () => void;
  onStop?: () => void;
  status?: PromptInputStatus;
  disabled?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  children?: React.ReactNode;
}) {
  return (
    <PromptInput onSubmit={onSubmit} disabled={disabled} data-testid="composer">
      <PromptInputHeader data-testid="header">{children}</PromptInputHeader>
      <PromptInputBody>
        <PromptInputTextarea
          aria-label="Message the assistant"
          value="Plan the launch"
          onChange={() => undefined}
          onKeyDown={onKeyDown}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputButton icon="plus" label="Add context" onClick={() => undefined} />
        </PromptInputTools>
        <PromptInputSubmit status={status} onStop={onStop} data-testid="send" />
      </PromptInputFooter>
    </PromptInput>
  );
}

const field = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;

describe('Enter', () => {
  it('sends, and Shift+Enter leaves a new line to the field', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const shifted = fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(shifted).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    const sent = fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sent).toBe(false);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('never sends while an IME composition is open, or on the 229 that ends one', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
    fireEvent.compositionStart(field());
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field());
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('is the caller’s when its own handler prevents it', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} onKeyDown={(event) => event.preventDefault()} />);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends on ⌘ or Ctrl+Enter alone where a bare Enter is the text’s new line', () => {
    const onSubmit = vi.fn();
    render(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea
            submitOn="mod+enter"
            aria-label="Message the assistant"
            value="A comment"
            onChange={() => undefined}
          />
        </PromptInputBody>
      </PromptInput>,
    );
    expect(field().hasAttribute('submitOn')).toBe(false);
    expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true, metaKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: 'Enter', metaKey: true, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })).toBe(false);
    expect(fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true })).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('sends while a turn runs too, for the caller to queue, but not while disabled', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} status="streaming" />);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
    rerender(<Composer onSubmit={onSubmit} disabled />);
    expect(field().disabled).toBe(true);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe('PromptInput', () => {
  it('is no form, so a form portalled out of a control inside it sends nothing', () => {
    const onSubmit = vi.fn();
    const outside = vi.fn((event: React.FormEvent) => event.preventDefault());
    const { container } = render(
      <Composer onSubmit={onSubmit}>
        {createPortal(
          <form data-testid="portalled" onSubmit={outside}>
            <input aria-label="Other model" />
          </form>,
          document.body,
        )}
      </Composer>,
    );
    expect(container.querySelector('form')).toBeNull();
    expect(screen.getByTestId('composer').tagName).toBe('DIV');
    fireEvent.submit(screen.getByTestId('portalled'));
    expect(outside).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('puts the caret in the field from a press on the pill, and leaves a button’s press alone', () => {
    render(<Composer />);
    fireEvent.click(screen.getByTestId('header'));
    expect(document.activeElement).toBe(field());
    field().blur();
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    expect(document.activeElement).not.toBe(field());
  });

  it('leaves a press in a panel portalled out of it alone, though React bubbles it here', () => {
    render(
      <Composer>
        {createPortal(
          <div data-testid="panel" tabIndex={-1}>
            Model and effort
          </div>,
          document.body,
        )}
      </Composer>,
    );
    const panel = screen.getByTestId('panel');
    panel.focus();
    fireEvent.click(panel);
    expect(document.activeElement).toBe(panel);
  });

  it('names its field, grows it to its text, and hands it to the caller’s ref', () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(72);
    const ref = { current: null as HTMLTextAreaElement | null };
    render(
      <PromptInput onSubmit={vi.fn()}>
        <PromptInputTextarea ref={ref} defaultValue="" />
      </PromptInput>,
    );
    const textarea = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    expect(ref.current).toBe(textarea);
    expect(textarea.rows).toBe(1);
    expect(textarea.placeholder).toBe('Ask anything…');
    fireEvent.input(textarea, { target: { value: 'One\nTwo\nThree' } });
    expect(textarea.style.height).toBe('72px');
  });

  it('says where a part must sit when it is used outside one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<PromptInputTextarea />)).toThrow(
      'PromptInputTextarea must sit inside a PromptInput',
    );
  });
});

describe('PromptInputSubmit', () => {
  it('sends while idle', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.dataset.status).toBe('ready');
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('stops a running turn it can stop, and still sends one it cannot', () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <Composer onSubmit={onSubmit} onStop={onStop} status="streaming" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<Composer onSubmit={onSubmit} onStop={onStop} status="submitted" />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    rerender(<Composer onSubmit={onSubmit} status="streaming" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('reads Stopping… and takes no press once asked to stop', () => {
    const onStop = vi.fn();
    render(<Composer onStop={onStop} status="stopping" />);
    const button = screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('is disabled with its field, unless the caller says otherwise', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} disabled />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputSubmit disabled />
      </PromptInput>,
    );
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a press the caller prevents sends nothing', () => {
    const onSubmit = vi.fn();
    render(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputSubmit onClick={(event) => event.preventDefault()} />
      </PromptInput>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
