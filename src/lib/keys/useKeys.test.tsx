import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableCommands, runCommand } from './registry';
import { activeChain } from './root';
import { useCommand, useCommands, useKeyScope } from './useKeys';

afterEach(cleanup);

function Page({ children }: { children?: ReactNode }) {
  const page = useKeyScope('page', { page: true });
  return (
    <main data-testid="page" {...page.props}>
      <page.Provider>{children}</page.Provider>
    </main>
  );
}

function Split({ run }: { run: () => void }) {
  useCommand('work.split', run);
  return null;
}

describe('useCommand', () => {
  it('binds on mount and disposes on unmount', () => {
    const run = vi.fn();
    const { rerender } = render(
      <Page>
        <Split run={run} />
      </Page>,
    );
    expect(runCommand('work.split', activeChain())).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    rerender(<Page />);
    expect(runCommand('work.split', activeChain())).toBe(false);
  });

  it('runs the latest closure without re-binding', () => {
    const seen: number[] = [];
    function Counter({ n }: { n: number }) {
      useCommand('work.split', () => seen.push(n));
      return null;
    }
    const { rerender } = render(
      <Page>
        <Counter n={1} />
      </Page>,
    );
    rerender(
      <Page>
        <Counter n={2} />
      </Page>,
    );
    runCommand('work.split', activeChain());
    expect(seen).toEqual([2]);
  });

  it('a re-render keeps the eclipse order', () => {
    const older = vi.fn();
    const newer = vi.fn();
    function Older({ n }: { n: number }) {
      useCommand('work.split', () => older(n));
      return null;
    }
    const tree = (n: number) => (
      <Page>
        <Older n={n} />
        <Split run={newer} />
      </Page>
    );
    const { rerender } = render(tree(1));
    // Child effects run in order, so the second sibling bound last.
    runCommand('work.split', activeChain());
    expect(newer).toHaveBeenCalledOnce();
    // Re-rendering the older binder with a new handler must not move it back
    // on top.
    rerender(tree(2));
    runCommand('work.split', activeChain());
    expect(newer).toHaveBeenCalledTimes(2);
    expect(older).not.toHaveBeenCalled();
  });

  it('takes its scope from the context, and an explicit scope over it', () => {
    function Block() {
      const block = useKeyScope('block');
      useCommands([{ id: 'diagram.undo', run: () => {} }], { scope: block });
      return <div data-testid="block" {...block.props} />;
    }
    function PageUndo() {
      useCommand('diagram.undo', () => {});
      return null;
    }
    const { getByTestId } = render(
      <Page>
        <PageUndo />
        <Block />
      </Page>,
    );
    const page = getByTestId('page').getAttribute('data-key-scope-id')!;
    const block = getByTestId('block').getAttribute('data-key-scope-id')!;
    expect(getByTestId('page').hasAttribute('data-key-scope-page')).toBe(true);
    expect(getByTestId('block').getAttribute('data-key-scope')).toBe('block');
    // diagram.undo is kept out of the palette, so ask the walk directly.
    expect(runCommand('diagram.undo', [page, 'app'])).toBe(true);
    expect(runCommand('diagram.undo', [block, 'app'])).toBe(true);
    expect(availableCommands([page, 'app'])).toEqual([]);
  });

  it('a page command outside any page binds in the root fallback page', () => {
    const run = vi.fn();
    render(<Split run={run} />);
    expect(runCommand('work.split', activeChain())).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('a command that fits no scope around it throws', () => {
    function Wrong() {
      const block = useKeyScope('block');
      useCommands([{ id: 'undo', run: () => {} }], { scope: block });
      return null;
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Wrong />)).toThrow(/not in scope "block"/);
    } finally {
      quiet.mockRestore();
    }
  });
});
