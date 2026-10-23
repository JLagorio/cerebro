// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StackTrace, StackTraceFrames } from './StackTrace';

/**
 * Stack Trace (M91.9): an error and the frames engine/ai/stackFrames.ts read
 * from it. A frame opens its file only when the file is a vault page, through
 * the caller, never an href (CV-16).
 */

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

const NODE = `TypeError: Cannot read properties of undefined (reading 'total')
    at formatInvoice (app/lib/billing.ts:42:31)
    at InvoiceRow (./app/components/invoice-row.tsx:18:12)
    at render (/Users/me/shop/server/render.ts:7:3)
    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:14985:18)
    at Array.map (<anonymous>)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const PYTHON = `Traceback (most recent call last):
  File "scripts/report.py", line 12, in <module>
    main()
  File "/usr/lib/python3.12/json/__init__.py", line 293, in load
    return loads(fp.read())
ValueError: Expecting value: line 1 column 1 (char 0)`;

/** Every link drawn goes to the web, never to a vault path (CV-16). */
function onlyWebLinks() {
  for (const link of document.querySelectorAll('a')) {
    expect(link.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
  }
}

describe('StackTrace', () => {
  it('is titled by the error, and starts closed', () => {
    render(<StackTrace trace={NODE} data-testid="trace" />);
    const trigger = screen.getByRole('button', {
      name: "Failed: TypeError: Cannot read properties of undefined (reading 'total')",
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const root = screen.getByTestId('trace');
    expect(root.dataset.slot).toBe('stack-trace');
    expect(root.dataset.language).toBe('javascript');
    expect(root.dataset.status).toBe('failed');
  });

  it('opens onto the whole error and the frames, innermost first', () => {
    render(<StackTrace trace={NODE} defaultOpen />);
    expect(document.querySelector('[data-slot="stack-trace-error"]')?.textContent).toBe(
      "TypeError: Cannot read properties of undefined (reading 'total')",
    );
    const frames = [...document.querySelectorAll('[data-frame]')].map((frame) =>
      frame.textContent?.trim(),
    );
    expect(frames).toEqual([
      'formatInvoice in app/lib/billing.ts:42',
      'InvoiceRow in app/components/invoice-row.tsx:18',
      'render in /Users/me/shop/server/render.ts:7',
    ]);
  });

  it('folds the runtime’s and the libraries’ frames into a line of their own', () => {
    render(<StackTrace trace={NODE} defaultOpen />);
    const fold = screen.getByRole('button', { name: '3 library and runtime frames' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    const raw = [...document.querySelectorAll('.cb-ai-stack-frames > li')].map(
      (item) => item.textContent,
    );
    expect(raw).toEqual([
      'at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:14985:18)',
      'at Array.map (<anonymous>)',
      'at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ]);
  });

  it('opens a frame’s file only for a relative vault path, at its line', () => {
    const onOpenPath = vi.fn();
    render(<StackTrace trace={NODE} defaultOpen onOpenPath={onOpenPath} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open formatInvoice in app/lib/billing.ts:42' }),
    );
    expect(onOpenPath).toHaveBeenCalledWith('app/lib/billing.ts', 42, 31);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open InvoiceRow in app/components/invoice-row.tsx:18' }),
    );
    expect(onOpenPath).toHaveBeenLastCalledWith('app/components/invoice-row.tsx', 18, 12);
    // An absolute path is text.
    expect(screen.queryByRole('button', { name: /render\.ts/ })).toBeNull();
    onlyWebLinks();
  });

  it('keeps every frame as text without a way to open it, or for a page the caller refuses', () => {
    const { rerender } = render(<StackTrace trace={NODE} defaultOpen />);
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    rerender(
      <StackTrace
        trace={NODE}
        defaultOpen
        onOpenPath={vi.fn()}
        isVaultPath={(path) => path.startsWith('app/lib/')}
      />,
    );
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(1);
  });

  it('never makes a button of a frame that leaves the vault or names a scheme', () => {
    const trace = `Error: boom
    at a (../outside/a.ts:1:1)
    at b (https://example.com/b.js:2:2)
    at c (webpack-internal:///./src/c.ts:3:3)`;
    render(<StackTrace trace={trace} defaultOpen onOpenPath={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    onlyWebLinks();
  });

  it('reads a Python traceback', () => {
    const onOpenPath = vi.fn();
    render(<StackTrace trace={PYTHON} defaultOpen onOpenPath={onOpenPath} />);
    expect(
      screen.getByRole('button', {
        name: 'Failed: ValueError: Expecting value: line 1 column 1 (char 0)',
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open <module> in scripts/report.py:12' }));
    expect(onOpenPath).toHaveBeenCalledWith('scripts/report.py', 12, undefined);
  });

  it('shows text with no trace in it as the error it is, with no frames', () => {
    render(<StackTrace trace={'Command timed out after 2m 0s\nkilled'} defaultOpen />);
    expect(
      screen.getByRole('button', { name: 'Failed: Command timed out after 2m 0s' }),
    ).toBeTruthy();
    expect(document.querySelector('[data-slot="stack-trace-error"]')?.textContent).toBe(
      'Command timed out after 2m 0s\nkilled',
    );
    expect(document.querySelector('[data-slot="stack-trace-frames"]')).toBeNull();
  });

  it('says when the error printed no message', () => {
    render(<StackTrace trace={'formatInvoice@https://example.com/app.js:42:31'} />);
    expect(screen.getByRole('button', { name: 'Failed with no message' })).toBeTruthy();
  });

  it('copies the error as printed', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<StackTrace trace={NODE} defaultOpen />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the error' }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(NODE);
  });

  it('keeps the folded frames’ open state while it is closed', () => {
    render(<StackTrace trace={NODE} defaultOpen />);
    fireEvent.click(screen.getByRole('button', { name: '3 library and runtime frames' }));
    const title = /^Failed: TypeError/;
    fireEvent.click(screen.getByRole('button', { name: title }));
    fireEvent.click(screen.getByRole('button', { name: title }));
    expect(
      screen
        .getByRole('button', { name: '3 library and runtime frames' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });
});

describe('StackTraceFrames', () => {
  it('lists frames with nothing folded when none is a library’s', () => {
    render(
      <StackTraceFrames
        frames={[
          {
            raw: 'at a (src/a.ts:1:2)',
            fn: 'a',
            file: 'src/a.ts',
            line: 1,
            column: 2,
            origin: 'relative',
          },
        ]}
      />,
    );
    expect(document.querySelector('[data-frame]')?.textContent).toBe('a in src/a.ts:1');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
