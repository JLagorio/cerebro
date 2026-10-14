import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useEscapeLayer } from '@/components/ui/Popover';

/**
 * Escape, while the composer has focus. A layer only then: one registered for
 * as long as the panel is open would take Escape from the drawer around it.
 */
function EscapeWhileFocused({ onEscape }: { onEscape: () => void }) {
  useEscapeLayer(onEscape);
  return null;
}

/**
 * Where a comment is written (M70.2b). ⌘Enter or the button posts; Escape
 * cancels. Disabled while a post is in flight, and the text stays when the
 * post fails, so nothing typed is lost to a refusal.
 */
export function CommentComposer({
  placeholder,
  submitLabel,
  testId,
  onSubmit,
  onCancel,
  autoFocus = false,
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
}) {
  const [text, setText] = useState('');
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

  return (
    <div className="flex flex-col gap-1.5">
      {focused && <EscapeWhileFocused onEscape={cancel} />}
      <textarea
        data-testid={`${testId}-input`}
        aria-label={placeholder}
        placeholder={placeholder}
        rows={2}
        value={text}
        disabled={busy}
        // A composer that opens with a draft is where the next keystroke goes.
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="w-full resize-y rounded-md border border-n-200 bg-n-0 px-2 py-1.5 text-sm text-n-800 outline-none placeholder:text-n-400 focus:border-cortex-500 disabled:opacity-60"
      />
      <div className="flex justify-end gap-1.5">
        {onCancel !== undefined && (
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          testId={testId}
          disabled={empty || busy}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
