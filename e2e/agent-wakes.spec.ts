import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * Durable wakes (M63.1): a change that matches an agent's trigger is admitted
 * once as a wake, and the run that claims it finishes it. Through the browser
 * mock's wake store (src/lib/mockIpc.ts), which mirrors `runtime::wakes`, and
 * the mock agent's `append "…" to <note>` script.
 *
 * `boot` pins the clock, so the 15-minute cooldown never ends inside this
 * spec: the second change waits as a pending wake for the rest of it, which
 * is what lets Pause be seen cancelling one. vitest's fake timers prove the
 * release (useJobRunner.test.tsx).
 */

const AGENT = 'records/agents/risk-watch.md';
const RISK = 'records/risks/risk-scanner-delivery.md';

// A scratch agent watching records/risks, on the mock disk before the first
// scan so the runner sees it.
const RISK_WATCH = [
  '---',
  'type: Agent',
  'slug: risk-watch',
  'when:',
  '  - event: changed',
  '    in: records/risks',
  '---',
  '',
  '# Risk watch',
  '',
  'Look over a risk that changed.',
  '',
].join('\n');

/** Every wake the mock holds, as subject, state, outcome, reason, detail. */
const wakes = (page: Page) =>
  page.evaluate(() =>
    window
      .__cerebroMockWakes()
      .map((w) =>
        [w.cause.subject, w.state, w.outcome, w.reason, w.detail].filter(Boolean).join(' '),
      ),
  );

/** Ask the panel to append `line` to the risk, and wait for its reply. */
async function append(page: Page, line: string, replies: number): Promise<void> {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(`append "${line}" to ${RISK}`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: `I appended that to ${RISK}.` }),
  ).toHaveCount(replies, { timeout: 10_000 });
}

test('agent wakes: a change wakes its agent once, the next waits under the cooldown, and Pause cancels it', async ({
  page,
}) => {
  await page.addInitScript(
    ({ path, md }) => {
      const plant = () => {
        const fs = (window as unknown as { __cerebroMockFs?: Map<string, string> }).__cerebroMockFs;
        if (fs === undefined) {
          setTimeout(plant, 5);
          return;
        }
        fs.set(path, md);
      };
      plant();
    },
    { path: AGENT, md: RISK_WATCH },
  );
  await boot(page, { autoLearn: true });
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();

  // One change: one wake, claimed by one run, which finishes it.
  await append(page, 'The vendor confirmed a new date.', 1);
  await expect.poll(() => wakes(page), { timeout: 30_000 }).toEqual([`${RISK} finished succeeded`]);

  // A second change inside the cooldown: admitted, and waiting.
  await append(page, 'The new date slipped again.', 2);
  await expect
    .poll(() => wakes(page), { timeout: 30_000 })
    .toEqual([`${RISK} finished succeeded`, `${RISK} pending`]);

  // Attribution comes from the panel write receipt, not from a guessed author.
  await page.getByTestId('nav-agent').filter({ hasText: 'Risk watch' }).click();
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  await page.getByTestId('agent-wake-author').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('agent-wake-author')).toBeVisible();
  await expect(page.getByTestId('agent-wake-author')).toHaveText('by Assistant');
  await page.screenshot({ path: test.info().outputPath('wake-author.png') });

  // Pause on the agent's page cancels the waiting wake, saying why.
  await page.getByTestId('nav-agent').filter({ hasText: 'Risk watch' }).click();
  await expect(page.getByTestId('agent-dossier')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('agent-duty-toggle').click();
  await expect
    .poll(() => wakes(page), { timeout: 30_000 })
    .toEqual([`${RISK} finished succeeded`, `${RISK} finished cancelled superseded paused`]);
});
