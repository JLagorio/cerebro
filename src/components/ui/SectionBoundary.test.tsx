import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SectionBoundary } from './SectionBoundary';

const trouble = { throws: true };
function Fragile({ name }: { name: string }) {
  if (trouble.throws) throw new Error(`${name} broke`);
  return <p>{name} drawn</p>;
}

beforeEach(() => {
  trouble.throws = true;
  // React reports every caught render fault; the boundary is what is measured.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SectionBoundary (M93.12)', () => {
  it('keeps a fault in its section and tells the owner once', () => {
    const onCatch = vi.fn();
    render(
      <>
        <p>Neighbour</p>
        <SectionBoundary label="This page" onCatch={onCatch}>
          <Fragile name="Page" />
        </SectionBoundary>
      </>,
    );
    expect(screen.getByText('Neighbour')).toBeTruthy();
    expect(screen.getByTestId('section-unavailable').textContent).toContain(
      'This page stopped drawing',
    );
    expect(onCatch).toHaveBeenCalledTimes(1);
    expect((onCatch.mock.calls[0][0] as Error).message).toBe('Page broke');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('draws the section again on Retry, and asks the owner nothing more', () => {
    const onCatch = vi.fn();
    render(
      <SectionBoundary label="This page" onCatch={onCatch}>
        <Fragile name="Page" />
      </SectionBoundary>,
    );
    trouble.throws = false;
    fireEvent.click(screen.getByTestId('section-retry'));
    expect(screen.getByText('Page drawn')).toBeTruthy();
    expect(onCatch).toHaveBeenCalledTimes(1);
  });

  it('starts over at a new reset key, and offers the owner its way back', () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <SectionBoundary label="This page" resetKey="a" onBack={onBack}>
        <Fragile name="A" />
      </SectionBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    trouble.throws = false;
    rerender(
      <SectionBoundary label="This page" resetKey="b" onBack={onBack}>
        <Fragile name="B" />
      </SectionBoundary>,
    );
    expect(screen.getByText('B drawn')).toBeTruthy();
  });

  it('stays down after a second fault, until a new reset key', () => {
    const { rerender } = render(
      <SectionBoundary label="This step" resetKey="a">
        <Fragile name="Step" />
      </SectionBoundary>,
    );
    fireEvent.click(screen.getByTestId('section-retry'));
    expect(screen.getByTestId('section-unavailable').textContent).toContain(
      'This step stopped drawing again',
    );
    expect(screen.queryByTestId('section-retry')).toBeNull();
    trouble.throws = false;
    rerender(
      <SectionBoundary label="This step" resetKey="b">
        <Fragile name="Step" />
      </SectionBoundary>,
    );
    expect(screen.getByText('Step drawn')).toBeTruthy();
  });

  it('mounts what must keep answering only while the section is down', () => {
    const Host = () => <p>host</p>;
    render(
      <SectionBoundary label="Cerebro" whileFailed={<Host />}>
        <Fragile name="App" />
      </SectionBoundary>,
    );
    expect(screen.getByText('host')).toBeTruthy();
    trouble.throws = false;
    fireEvent.click(screen.getByTestId('section-retry'));
    expect(screen.queryByText('host')).toBeNull();
  });
});
