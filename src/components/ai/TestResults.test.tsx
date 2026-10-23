// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testReportOf, type TestReport } from '@/engine/ai/testReport';
import { TestResults, cutWords, testRunTitle } from './TestResults';

/**
 * Test Results (M91.9): a run as its runner reported it, read by
 * engine/ai/testReport.ts. Output with no summary is no report, and draws
 * nothing (Q11, CV-05).
 */

afterEach(cleanup);

/** `vitest run` on three files: two with failures, one that does not load
 *  (testReport.test.ts's recording, trimmed). */
const VITEST = testReportOf({
  type: 'shell',
  stdout: `
 RUN  v3.2.7 /Users/me/shop

 ❯ src/cart.test.ts (5 tests | 1 failed | 2 skipped) 5ms
   ✓ cart > adds an item 1ms
   ✓ cart > removes an item 0ms
   × cart > applies a discount code 4ms
     → expected 90 to be 80 // Object.is equality
   ↓ cart > ships abroad
   ↓ cart > handles gift cards
 ❯ src/payment.test.ts (2 tests | 1 failed) 7ms
   ✓ payment > charges the saved card 1ms
   × payment > retries a declined card 5ms
     → expected { attempts: 1 } to deeply equal { attempts: 2 }

 Test Files  3 failed (3)
      Tests  2 failed | 3 passed | 1 skipped | 1 todo (7)
   Start at  08:40:07
   Duration  417ms (transform 97ms, setup 0ms, collect 62ms, tests 12ms, environment 0ms, prepare 257ms)
`,
  stderr: `
 FAIL  src/cart.test.ts > cart > applies a discount code
AssertionError: expected 90 to be 80 // Object.is equality

 ❯ src/cart.test.ts:6:19
      6|     expect(total).toBe(80);

 FAIL  src/payment.test.ts > payment > retries a declined card
AssertionError: expected { attempts: 1 } to deeply equal { attempts: 2 }

 ❯ /Users/me/shop/src/payment.test.ts:4:29
`,
  interrupted: false,
  truncated: false,
}) as TestReport;

function report(over: Partial<TestReport> = {}): TestReport {
  return {
    runner: 'vitest',
    totals: { passed: 3, failed: 0, skipped: 0, total: 3 },
    failures: [],
    cut: false,
    ...over,
  };
}

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement;

describe('TestResults', () => {
  it('draws nothing for output with no summary, so the caller shows the output', () => {
    const { container } = render(<TestResults report={null} title="Ran pnpm test" />);
    expect(container.firstChild).toBeNull();
  });

  it('counts the run in its line, and opens when anything failed', () => {
    expect(VITEST.totals).toMatchObject({ passed: 3, failed: 2, skipped: 2, total: 7 });
    render(<TestResults report={VITEST} />);
    const trigger = screen.getByRole('button', { name: 'Ran 7 tests, 2 failed, 2 skipped 417ms' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(slot('test-results').dataset.status).toBe('failed');
    expect(slot('test-results').dataset.runner).toBe('vitest');
  });

  it('says its totals in words', () => {
    render(<TestResults report={VITEST} />);
    expect(slot('test-results-summary').textContent).toBe(
      'Passed: 3Failed: 2Skipped: 2Failed files: 3',
    );
  });

  it('lists the failures first, each open on its error', () => {
    render(<TestResults report={VITEST} />);
    const failures = slot('test-failures');
    const suites = slot('test-suites');
    expect(
      failures.compareDocumentPosition(suites) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const first = within(failures).getByRole('button', {
      name: 'Failed: cart > applies a discount code',
    });
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(failures.textContent).toContain('AssertionError: expected 90 to be 80');
  });

  it('opens a failure’s place only when it is a vault page (CV-16)', () => {
    const onOpenPath = vi.fn();
    render(<TestResults report={VITEST} onOpenPath={onOpenPath} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open src/cart.test.ts:6:19' }));
    expect(onOpenPath).toHaveBeenCalledWith('src/cart.test.ts', 6, 19);
    // An absolute path is text.
    expect(screen.queryByRole('button', { name: /payment\.test\.ts:4:29/ })).toBeNull();
    expect(slot('test-failures').textContent).toContain('/Users/me/shop/src/payment.test.ts:4:29');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('keeps a place as text with no way to open it, or one the caller refuses', () => {
    const { rerender } = render(<TestResults report={VITEST} />);
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    rerender(<TestResults report={VITEST} onOpenPath={vi.fn()} isVaultPath={() => false} />);
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(slot('test-failures').textContent).toContain('src/cart.test.ts:6:19');
  });

  it('opens each suite onto its cases, failed ones first, each status in words', () => {
    render(<TestResults report={VITEST} />);
    const suites = slot('test-suites');
    const cart = within(suites).getByRole('button', { name: 'Failed: src/cart.test.ts' });
    expect(cart.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(cart);
    const cases = [...cart.closest('[data-slot="test-suite"]')!.querySelectorAll('[data-result]')];
    expect(cases.map((line) => line.textContent)).toEqual([
      'Failed: cart > applies a discount code4ms',
      'Passed: cart > adds an item1ms',
      'Passed: cart > removes an item0ms',
      'Skipped cart > ships abroad',
      'Skipped cart > handles gift cards',
    ]);
    // No suite claims a count: the cases are those the output still shows.
    expect(suites.textContent).not.toMatch(/\d+ tests?/);
  });

  it('starts closed when everything passed, and says so', () => {
    render(
      <TestResults
        report={report({
          totals: { passed: 3, failed: 0, skipped: 0, total: 3, durationMs: 1390 },
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Passed: Ran 3 tests 1.4s' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(slot('test-results').dataset.status).toBe('done');
  });

  it('fails a run with an error outside its tests, and says so first', () => {
    render(
      <TestResults
        report={report({ totals: { passed: 3, failed: 0, skipped: 0, total: 3, errors: 1 } })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Failed: Ran 3 tests, 1 error' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(slot('test-results-summary').textContent).toContain('Errors: 1');
  });

  it('fails a run with a file that never loaded, though every test passed', () => {
    render(
      <TestResults
        report={report({
          totals: {
            passed: 3,
            failed: 0,
            skipped: 0,
            total: 3,
            files: { passed: 1, failed: 1, total: 2 },
          },
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Failed: Ran 3 tests' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(slot('test-results').dataset.status).toBe('failed');
    expect(slot('test-results-summary').textContent).toContain('Failed files: 1');
  });

  it('says how many failures it shows of how many the runner counted', () => {
    render(
      <TestResults
        report={report({
          totals: { passed: 292, failed: 8, skipped: 0, total: 300 },
          failures: [{ name: 'module 29 > case 5' }, { name: 'module 30 > case 10' }],
          cut: true,
        })}
      />,
    );
    expect(slot('test-results-cut').textContent).toBe(
      'Showing 2 of 8 failures; the output no longer shows the rest.',
    );
    // A failure with nothing more to show is a plain line.
    expect(screen.queryByRole('button', { name: 'Failed: module 29 > case 5' })).toBeNull();
    expect(slot('test-failures').textContent).toContain('Failed: module 29 > case 5');
  });

  it('words a cut list', () => {
    expect(cutWords(0, 1)).toBe('The output no longer shows its 1 failure.');
    expect(cutWords(3, 8)).toBe('Showing 3 of 8 failures; the output no longer shows the rest.');
  });

  it('titles the counts that are not zero', () => {
    expect(testRunTitle({ passed: 1, failed: 0, skipped: 0, total: 1 })).toBe('Ran 1 test');
    expect(testRunTitle({ passed: 0, failed: 2, skipped: 1, total: 3, errors: 2 })).toBe(
      'Ran 3 tests, 2 failed, 1 skipped, 2 errors',
    );
  });

  it('takes the caller’s title, and its open state', () => {
    const onOpenChange = vi.fn();
    render(
      <TestResults
        report={VITEST}
        title="Ran pnpm test"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Failed: Ran pnpm test 417ms' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
