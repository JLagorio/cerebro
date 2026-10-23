import { expect, test, type Page } from '@playwright/test';
import { askAssistant, assistantSettled, boot, openAssistantPanel } from './boot';

/**
 * A command's output, read (M91.15, Q11): the mock's `run the tests` script
 * runs the vault's tests through Bash, and `fail with a stack trace` a render
 * that dies inside a vault page, each with the shell result Rust's fold sends.
 * A test run reads as Test Results, counted from the runner's own summary; a
 * failed command is a Terminal, and the stack it printed a Stack Trace whose
 * vault frames open their page in the app (CV-16). Shell access is on, as a
 * person turns it on in Settings.
 */

async function bootWithShell(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem('cerebro.agentShell', 'on'));
  await boot(page);
  await openAssistantPanel(page);
}

const reply = (page: Page) =>
  page.getByTestId('ai-panel').locator('[data-testid="chat-message"][data-role="assistant"]');

test('run the tests: the run reads as Test Results, counted from the runner, its one failure listed', async ({
  page,
}) => {
  await bootWithShell(page);
  await askAssistant(page, 'run the tests');
  await assistantSettled(page, 1);

  const results = reply(page).locator('[data-slot="test-results"]');
  await expect(results).toHaveAttribute('data-testid', 'action-card');
  await expect(results).toHaveAttribute('data-tool', 'Bash');
  await expect(results).toHaveAttribute('data-runner', 'vitest');
  // A failing run opens by itself.
  await expect(
    results.getByRole('button', { name: /^Ran 19 tests, 1 failed/ }).first(),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(results.locator('[data-slot="test-results-summary"]')).toHaveText(
    /Passed: 18\s*Failed: 1/,
  );
  // The one failure, with the runner's words and where it was raised.
  const failures = results.locator('[data-slot="test-failures"] > [data-slot="test-failure"]');
  await expect(failures).toHaveCount(1);
  await expect(
    failures.getByRole('button', { name: 'Failed: risks > flags a risk with no mitigation' }),
  ).toBeVisible();
  await expect(failures).toContainText(
    'AssertionError: expected [] to have a length of 1 but got +0',
  );
  await expect(
    failures.getByRole('button', { name: 'Open scripts/risks.test.mjs:27:21' }),
  ).toBeVisible();
  // Its suite, failed first.
  await expect(
    results.locator('[data-slot="test-suite"]').getByRole('button', {
      name: 'Failed: scripts/risks.test.mjs',
    }),
  ).toBeVisible();
  // Not drawn as a bare terminal, and no count the runner did not print.
  await expect(reply(page).locator('[data-slot="terminal"]')).toHaveCount(0);
  await expect(reply(page)).toContainText('The tests ran: 18 passed and 1 failed.');
});

test('fail with a stack trace: a failed command shows its stack, and a vault frame opens its page', async ({
  page,
}) => {
  await bootWithShell(page);
  await askAssistant(page, 'fail with a stack trace');
  await assistantSettled(page, 1);

  // A Terminal: the command's line, opening onto what ran and what it printed,
  // its error output ruled off.
  const command = reply(page).locator('[data-slot="terminal"]');
  await expect(command).toHaveAttribute('data-status', 'failed');
  await expect(command).toHaveAttribute('data-tool', 'Bash');
  const line = command.getByRole('button', {
    name: /^Failed to run a command node scripts\/render-notes\.mjs/,
  });
  await expect(line).toHaveAttribute('aria-expanded', 'false');
  await line.click();
  await expect(command.locator('[data-slot="terminal-command"]')).toContainText(
    'node scripts/render-notes.mjs',
  );
  await expect(command.locator('[data-slot="terminal-stderr"]')).toContainText(
    'ReferenceError: owner is not defined',
  );
  await expect(command.locator('[data-slot="terminal-stdout"]')).toHaveCount(0);

  // Under the command's line, closed: the stack it printed.
  const trace = command.locator('[data-slot="stack-trace"]');
  await expect(trace).toHaveAttribute('data-language', 'javascript');
  const opener = trace.getByRole('button', { name: 'Failed: Stack trace', exact: true });
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await opener.click();
  await expect(trace.locator('[data-slot="stack-trace-error"]')).toHaveText(
    'ReferenceError: owner is not defined',
  );

  // Innermost first. A frame in a vault page is a button; a file URL is text,
  // and the runtime's frames fold into a line of their own.
  const frames = trace.locator('[data-slot="stack-trace-frames"]');
  await expect(frames.locator('button[data-frame]')).toHaveText([
    'Open _createMdxContent in records/risks/risk-scanner-delivery.md:6',
    'Open MDXContent in records/risks/risk-scanner-delivery.md:14',
  ]);
  await expect(frames.locator('span[data-frame]')).toHaveText([
    'renderNote in file:///vault/scripts/render-notes.mjs:21',
    'async main in file:///vault/scripts/render-notes.mjs:34',
  ]);
  await expect(frames.locator('a')).toHaveCount(0);
  await expect(
    frames.getByRole('button', { name: '1 library or runtime frame', exact: true }),
  ).toBeVisible();

  // The vault frame opens its page in the app, where a record opens: its
  // database in the pane, the page itself in the peek.
  await frames
    .getByRole('button', {
      name: 'Open _createMdxContent in records/risks/risk-scanner-delivery.md:6',
    })
    .click();
  await expect(page.getByTestId('detail-panel').locator('[data-page-title] h1')).toHaveText(
    'Scanner hardware delivery is slipping',
  );
  await expect(
    page.locator('[data-pane-index="0"]').getByRole('grid', { name: 'Risk records' }),
  ).toBeVisible();
});
