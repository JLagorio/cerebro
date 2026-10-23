// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
  diffLineVariants,
  HIGHLIGHT_LIMIT,
  STREAM_PASS_MS,
} from './CodeBlock';

/**
 * Code Block (M91.7). The app's Shiki is stood in for: each pass waits until
 * the case lands it, and draws what workspace/highlighter.tsx draws — a
 * fragment of `pre > code > span.line` — with a marked token per line.
 */

const { highlight } = vi.hoisted(() => ({ highlight: vi.fn() }));
vi.mock('@/workspace/highlighter', () => ({ highlight }));

interface Pass {
  code: string;
  language: string | null;
  theme: string;
  land: () => Promise<void>;
}

let passes: Pass[] = [];

function drawn(code: string, theme: string): ReactNode {
  return (
    <>
      <pre className="shiki">
        <code>
          {code.split('\n').map((line, index) => (
            <span key={index} className="line">
              {line === '' ? undefined : <span data-token={theme}>{line}</span>}
            </span>
          ))}
        </code>
      </pre>
    </>
  );
}

beforeEach(() => {
  passes = [];
  highlight.mockImplementation(
    (code: string, language: string | null, theme: string) =>
      new Promise<ReactNode>((resolve) => {
        passes.push({
          code,
          language,
          theme,
          land: () =>
            act(async () => {
              resolve(drawn(code, theme));
            }),
        });
      }),
  );
});

afterEach(() => {
  cleanup();
  highlight.mockReset();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

/** The text of each drawn line, and whether it is coloured. */
function lines(): { text: string; coloured: boolean }[] {
  return [...document.querySelectorAll('[data-slot="code-block-line"]')].map((line) => ({
    text: line.textContent ?? '',
    coloured: line.querySelector('[data-token]') !== null,
  }));
}

function Block({
  code,
  language = 'ts',
  theme = 'light',
}: {
  code: string;
  language?: string | null;
  theme?: 'light' | 'dark';
}) {
  return (
    <CodeBlock>
      <CodeBlockContent code={code} language={language} theme={theme} />
    </CodeBlock>
  );
}

describe('highlighting', () => {
  it('shows plain text until the grammar loads, then the highlighted lines', async () => {
    render(<Block code={'const a = 1\nconst b = 2\n'} />);
    expect(lines()).toEqual([
      { text: 'const a = 1', coloured: false },
      { text: 'const b = 2', coloured: false },
    ]);
    expect(highlight).toHaveBeenCalledWith('const a = 1\nconst b = 2', 'ts', 'light');
    await passes[0].land();
    expect(lines()).toEqual([
      { text: 'const a = 1', coloured: true },
      { text: 'const b = 2', coloured: true },
    ]);
  });

  it('keeps what is coloured while more streams in, and colours the rest when its pass lands', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Block code={'const a = 1\nconst b'} />);
    await passes[0].land();
    // The last line has grown, so it draws plain; the one before keeps its colour.
    rerender(<Block code={'const a = 1\nconst b = 2'} />);
    expect(lines()).toEqual([
      { text: 'const a = 1', coloured: true },
      { text: 'const b = 2', coloured: false },
    ]);
    act(() => vi.advanceTimersByTime(STREAM_PASS_MS));
    // A newline after the pass's last line says that line was whole.
    await passes[1].land();
    rerender(<Block code={'const a = 1\nconst b = 2\nconst c'} />);
    expect(lines()).toEqual([
      { text: 'const a = 1', coloured: true },
      { text: 'const b = 2', coloured: true },
      { text: 'const c', coloured: false },
    ]);
    act(() => vi.advanceTimersByTime(STREAM_PASS_MS));
    await passes[2].land();
    expect(lines().every((line) => line.coloured)).toBe(true);
  });

  it('while text streams in, starts at most one pass per interval, and the last text gets its pass', async () => {
    vi.useFakeTimers();
    let code = 'const a = 1';
    const { rerender } = render(<Block code={code} />);
    await passes[0].land();
    // Forty deltas inside one interval start no pass each.
    for (let delta = 0; delta < 40; delta += 1) {
      code += `\nconst v${delta} = ${delta}`;
      rerender(<Block code={code} />);
    }
    expect(highlight).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(STREAM_PASS_MS));
    expect(highlight).toHaveBeenCalledTimes(2);
    expect(highlight).toHaveBeenLastCalledWith(code, 'ts', 'light');
    await passes[1].land();
    expect(lines().every((line) => line.coloured)).toBe(true);
  });

  it('draws text past the limit plain, with no pass', () => {
    render(<Block code={'x'.repeat(HIGHLIGHT_LIMIT + 1)} />);
    expect(highlight).not.toHaveBeenCalled();
    expect(lines()).toEqual([{ text: 'x'.repeat(HIGHLIGHT_LIMIT + 1), coloured: false }]);
  });

  it('a pass for text since replaced is dropped', async () => {
    const { rerender } = render(<Block code="first" />);
    rerender(<Block code="second" />);
    await passes[0].land();
    expect(lines()).toEqual([{ text: 'second', coloured: false }]);
    await passes[1].land();
    expect(lines()).toEqual([{ text: 'second', coloured: true }]);
  });

  it('highlights again for a new theme, and draws plain rather than the old colours', async () => {
    const { rerender } = render(<Block code="let x" />);
    await passes[0].land();
    rerender(<Block code="let x" theme="dark" />);
    expect(highlight).toHaveBeenLastCalledWith('let x', 'ts', 'dark');
    expect(lines()).toEqual([{ text: 'let x', coloured: false }]);
    await passes[1].land();
    expect(document.querySelector('[data-token]')?.getAttribute('data-token')).toBe('dark');
  });

  it('loads no grammar for text', () => {
    render(
      <>
        <Block code="plain" language={null} />
        <Block code="also plain" language="text" />
      </>,
    );
    expect(highlight).not.toHaveBeenCalled();
    expect(lines().map((line) => line.text)).toEqual(['plain', 'also plain']);
  });

  it('draws ansi output plain, without its escape codes', () => {
    render(
      <Block
        code={'\u001b[32m✓\u001b[39m 14 passed\n\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007'}
        language="ansi"
      />,
    );
    expect(highlight).not.toHaveBeenCalled();
    expect(lines().map((line) => line.text)).toEqual(['✓ 14 passed', 'link']);
  });

  it('marks a diff’s added and removed lines, not its file headers', async () => {
    render(
      <Block
        code={'--- a/greeting.tsx\n+++ b/greeting.tsx\n@@ -1 +1 @@\n-Hello\n+Hello, world\n same'}
        language="diff"
      />,
    );
    const variants = () =>
      [...document.querySelectorAll('[data-slot="code-block-line"]')].map((line) =>
        line.getAttribute('data-variant'),
      );
    expect(variants()).toEqual(['default', 'default', 'default', 'removed', 'added', 'default']);
    await passes[0].land();
    expect(variants()).toEqual(['default', 'default', 'default', 'removed', 'added', 'default']);
    expect(document.querySelector('pre')?.getAttribute('data-language')).toBe('diff');
  });
});

describe('diffLineVariants', () => {
  it('reads a hand-written diff with no hunk header as all changes', () => {
    expect(diffLineVariants([' a', '-b', '+c'])).toEqual(['default', 'removed', 'added']);
  });

  it('starts over at each file', () => {
    expect(
      diffLineVariants(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-x', '+y']),
    ).toEqual(['default', 'default', 'default', 'default', 'removed', 'added']);
  });
});

describe('the copy button', () => {
  function clipboard(writeText: () => Promise<void>) {
    const spy = vi.fn(writeText);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: spy },
    });
    return spy;
  }

  function Copyable() {
    return (
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle>Terminal</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value="pnpm add ai" />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent>pnpm add ai</CodeBlockContent>
      </CodeBlock>
    );
  }

  it('writes the value and announces Copied', async () => {
    const write = clipboard(() => Promise.resolve());
    render(<Copyable />);
    expect(screen.getByRole('status').textContent).toBe('');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(write).toHaveBeenCalledWith('pnpm add ai');
    expect(screen.getByRole('status').textContent).toBe('Copied');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('reads as it did again after a moment', async () => {
    vi.useFakeTimers();
    clipboard(() => Promise.resolve());
    render(<Copyable />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Copied');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('says so when the clipboard refuses', async () => {
    clipboard(() => Promise.reject(new Error('denied')));
    render(<Copyable />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(screen.getByRole('status').textContent).toBe("Couldn't copy");
    expect(screen.getByRole('button', { name: "Couldn't copy" })).toBeTruthy();
  });

  it('says so where there is no clipboard at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(<Copyable />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(screen.getByRole('status').textContent).toBe("Couldn't copy");
  });

  it('takes a name of its own, and a disabled one copies nothing', () => {
    const write = clipboard(() => Promise.resolve());
    render(<CodeBlockCopyButton value="x" label="Copy output" disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(write).not.toHaveBeenCalled();
  });
});

describe('the block', () => {
  it('marks a destructive block by its class and variant', () => {
    render(
      <CodeBlock variant="destructive" size="sm" data-testid="block">
        <CodeBlockContent wrap>TypeError: undefined</CodeBlockContent>
      </CodeBlock>,
    );
    const block = screen.getByTestId('block');
    expect(block.classList.contains('cb-ai-code-block-destructive')).toBe(true);
    expect(block.classList.contains('cb-ai-code-block-sm')).toBe(true);
    expect(block.dataset.variant).toBe('destructive');
    expect(block.querySelector('pre')?.hasAttribute('data-wrap')).toBe(true);
  });

  it('a default block carries no destructive class', () => {
    render(
      <CodeBlock data-testid="block">
        <CodeBlockContent>ok</CodeBlockContent>
      </CodeBlock>,
    );
    expect(screen.getByTestId('block').className).toBe('cb-ai-code-block');
  });

  it('reads left to right and takes keyboard focus unless told not to', () => {
    render(
      <>
        <CodeBlockContent data-testid="focusable">a</CodeBlockContent>
        <CodeBlockContent data-testid="skipped" tabIndex={-1}>
          b
        </CodeBlockContent>
      </>,
    );
    const focusable = screen.getByTestId('focusable');
    expect(focusable.tagName).toBe('PRE');
    expect(focusable.getAttribute('dir')).toBe('ltr');
    expect(focusable.tabIndex).toBe(0);
    expect(screen.getByTestId('skipped').tabIndex).toBe(-1);
  });

  it('numbers a string by splitting it into lines from its start line', () => {
    render(
      <CodeBlockContent lineNumbers startLine={10} data-testid="numbered">
        {'one\n\nthree\n'}
      </CodeBlockContent>,
    );
    const pre = screen.getByTestId('numbered');
    expect(pre.hasAttribute('data-numbered')).toBe(true);
    expect(pre.style.counterReset).toBe('cb-ai-line 9');
    // A blank line holds a newline, so a copied selection keeps it.
    expect(lines().map((line) => line.text)).toEqual(['one', '\n', 'three']);
  });

  it('keeps a string as one text node without line numbers', () => {
    render(<CodeBlockContent>{'one\ntwo'}</CodeBlockContent>);
    expect(lines()).toEqual([]);
    expect(document.querySelector('code')?.textContent).toBe('one\ntwo');
  });

  it('draws marked lines a caller builds', () => {
    render(
      <CodeBlockContent>
        <CodeBlockLine variant="added">{'+ added'}</CodeBlockLine>
        <CodeBlockLine variant="highlighted">kept</CodeBlockLine>
        <CodeBlockLine />
      </CodeBlockContent>,
    );
    const drawnLines = document.querySelectorAll('[data-slot="code-block-line"]');
    expect([...drawnLines].map((line) => line.getAttribute('data-variant'))).toEqual([
      'added',
      'highlighted',
      'default',
    ]);
    expect(drawnLines[2].textContent).toBe('\n');
  });

  it('keeps shadcn’s anatomy', () => {
    render(
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle>route.ts</CodeBlockTitle>
        </CodeBlockHeader>
        <CodeBlockContent>x</CodeBlockContent>
        <CodeBlockFooter>Show more</CodeBlockFooter>
      </CodeBlock>,
    );
    expect(
      [...document.querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot')),
    ).toEqual([
      'code-block',
      'code-block-header',
      'code-block-title',
      'code-block-content',
      'code-block-code',
      'code-block-footer',
    ]);
  });
});
