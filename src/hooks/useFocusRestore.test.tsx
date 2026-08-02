import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { useFocusRestore } from './useFocusRestore';

afterEach(cleanup);

/**
 * A surface that focuses a field of its own the moment it opens — the
 * assistant's composer, QuickOpen's input — is exactly the case the effect
 * version of this got wrong, so the fixture has one.
 */
function Composer() {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return <textarea ref={ref} aria-label="Composer" />;
}

function Panel() {
  useFocusRestore();
  return <Composer />;
}

function Harness({ open }: { open: boolean }) {
  return (
    <>
      <button type="button">Opener</button>
      {open ? <Panel /> : null}
    </>
  );
}

describe('useFocusRestore', () => {
  it('returns focus to the opener even though the surface focused its own field', () => {
    const { rerender } = render(<Harness open={false} />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    // Opening: the composer claims focus during commit, before any effect in
    // the panel could have looked at `document.activeElement`. Reading the
    // opener from an effect recorded THIS textarea, which is unmounted — and
    // so unfocusable — by the time the restore wants it, dropping focus to
    // <body> on every close.
    rerender(<Harness open />);
    expect(document.activeElement).toBe(screen.getByLabelText('Composer'));

    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(opener);
  });

  it('does nothing when nothing held focus', () => {
    const { rerender } = render(<Harness open={false} />);
    // <body> is not an opener: it is where focus goes when there is none.
    expect(document.activeElement).toBe(document.body);
    rerender(<Harness open />);
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(document.body);
  });

  it('survives an opener that left the document while the surface was open', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { rerender } = render(<Harness open />);
    opener.remove();
    expect(() => rerender(<Harness open={false} />)).not.toThrow();
  });
});
