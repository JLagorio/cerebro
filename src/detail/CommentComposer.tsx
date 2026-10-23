import { Keycaps } from '@/components/ui/Keycaps';
import { useState } from 'react';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai/PromptInput';
import { Button } from '@/components/ui/Button';
import { useEscapeLayer } from '@/components/ui/Popover';
import './comments.css';

/**
 * Escape, while the composer has focus. A layer only then: one registered for
 * as long as the panel is open would take Escape from the drawer around it.
 */
function EscapeWhileFocused({ onEscape }: { onEscape: () => void }) {
  useEscapeLayer(onEscape);
  return null;
}

/**
 * Where a comment is written (M70.2b), on the Prompt Input's anatomy
 * (M91.14): the text, then a quiet bar with the keys and the button inside
 * the same box. ⌘Enter or the button posts — a comment runs to paragraphs, so
 * a bare Enter is its new line — and Escape cancels. Disabled while a post is
 * in flight, and the text stays when the post fails, so nothing typed is lost
 * to a refusal. Posting writes the comment only; whether it asks an agent is
 * the thread's to read from the person's own `@handle` (CV-36).
 */
export function CommentComposer({
  placeholder,
  submitLabel,
  testId,
  onSubmit,
  onCancel,
  autoFocus = false,
  draft,
}: {
  placeholder: string;
  submitLabel: string;
  /** The submit button's test id; the textarea's is `${testId}-input`. */
  testId: string;
  /** Answers whether the post landed. */
  onSubmit: (body: string) => Promise<unknown>;
  /** What Escape does; by default it clears the text. */
  onCancel?: () => void;
  autoFocus?: boolean;
  draft?: { read(): string; write(value: string): void };
}) {
  const [text, setLocalText] = useState(() => draft?.read() ?? '');
  const setText = (value: string) => {
    setLocalText(value);
    draft?.write(value);
  };
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const empty = text.trim() === '';

  const submit = async () => {
    if (empty || busy) return;
    setBusy(true);
    try {
      const landed = await onSubmit(text);
      if (landed !== null && landed !== false) setText('');
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setText('');
    onCancel?.();
  };

  // One box, the way a chat composer reads. The box takes the focus ring, so
  // the field and its button read as one control.
  return (
    <PromptInput
      onSubmit={() => void submit()}
      disabled={busy}
      data-busy={busy || undefined}
      className="cb-composer"
    >
      {focused && <EscapeWhileFocused onEscape={cancel} />}
      <PromptInputBody>
        <PromptInputTextarea
          data-testid={`${testId}-input`}
          aria-label={placeholder}
          placeholder={placeholder}
          submitOn="mod+enter"
          rows={2}
          value={text}
          // A composer that opens with a draft is where the next keystroke goes.
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          className="cb-composer-input"
        />
      </PromptInputBody>
      <PromptInputFooter className="cb-composer-bar">
        <span className="cb-composer-keys" aria-hidden="true">
          <Keycaps keys="mod+enter" />
        </span>
        {onCancel !== undefined && (
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <PromptInputSubmit
          data-testid={testId}
          aria-label={submitLabel}
          disabled={empty || busy}
          className="cb-composer-submit"
        >
          {submitLabel}
        </PromptInputSubmit>
      </PromptInputFooter>
    </PromptInput>
  );
}
