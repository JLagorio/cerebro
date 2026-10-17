import { expect, test, type Page } from '@playwright/test';
import cases from '../src-tauri/fixtures/pr-cases.json' with { type: 'json' };
import { boot, openStateLab, readMockFile } from './boot';
const PATH = 'records/pr-work.md';
const URL = 'https://github.com/acme/notes/pull/42';
const RAW = `---\ntype: PR work\nstatus: active\n---\n\n# PR work\n\nImplement this change: [pull request](${URL}/files).\n`;
async function seed(page: Page, state: string | null) {
  const result = state === null ? null : cases.cases.find((c) => c.name === state)!.expect;
  await page.addInitScript(
    ({ path, raw, url, result }) => {
      (window as unknown as { __cerebroPullRequests: unknown }).__cerebroPullRequests =
        result === null ? {} : { [url]: result };
      Object.defineProperty(window, '__cerebroMockFs', {
        configurable: true,
        set(map: Map<string, string>) {
          map.set(path, raw);
          map.set(
            'types/pr-work.md',
            '---\ntype: Type\nfields:\n  status: status\nstatuses:\n  - {id: active, group: active}\n  - {id: done, label: Done, group: done}\n---\n\n# PR work\n',
          );
          Object.defineProperty(window, '__cerebroMockFs', {
            configurable: true,
            writable: true,
            value: map,
          });
        },
      });
    },
    { path: PATH, raw: RAW, url: URL, result },
  );
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('PR work');
  await page.getByTestId('quick-open-result').filter({ hasText: 'PR work' }).first().click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
}
test('an unread pull request stays checks unknown on both peek and page', async ({ page }) => {
  await seed(page, null);
  const peek = page.getByTestId('detail-panel');
  await expect(peek.getByTestId('pr-chip')).toHaveAttribute('data-readiness', 'checks_unknown');
  await expect(peek.getByTestId('pr-chip')).toContainText('checks unknown');
  await peek.getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('pr-chip')).toHaveAttribute('data-state', 'gh_missing');
  await expect(page.getByTestId('pr-chip')).not.toContainText('ready');
  expect(await readMockFile(page, PATH)).toBe(RAW);
});
test('both check shapes read ready and the chip stays within its page', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await seed(page, 'passing-both-shapes');
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  const chip = page.getByTestId('pr-chip');
  await expect(chip).toHaveAttribute('data-readiness', 'ready');
  await expect(chip).toContainText('ready');
  expect(await chip.getByRole('link').getAttribute('href')).toBe(URL);
  const box = await chip.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1100);
  await page.screenshot({ path: info.outputPath('pr-chip-ready.png'), animations: 'disabled' });
});
test('a merged PR offers one undoable Done status patch', async ({ page }) => {
  await seed(page, 'merged');
  const peek = page.getByTestId('detail-panel');
  await expect(peek.getByTestId('pr-chip')).toContainText('merged');
  await peek.getByRole('button', { name: 'Mark “Done”' }).click();
  await expect.poll(() => readMockFile(page, PATH)).toContain('status: done');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => readMockFile(page, PATH)).toBe(RAW);
});

test('the five PR strip presets keep missing, unknown and unavailable distinct', async ({
  page,
}) => {
  for (const state of ['ready', 'empty', 'not-recorded', 'partial', 'unavailable']) {
    await openStateLab(page, 'pull-request-strip', state);
    const stage = page.getByTestId('lab-stage');
    if (state === 'empty') {
      await expect(stage.getByTestId('pr-chip')).toHaveCount(0);
      await expect(stage.getByTestId('section-unavailable')).toHaveCount(0);
    } else if (state === 'unavailable')
      await expect(stage.getByTestId('section-unavailable')).toContainText('could not be read');
    else
      await expect(stage.getByTestId('pr-chip')).toHaveAttribute(
        'data-readiness',
        state === 'ready' ? 'ready' : 'checks_unknown',
      );
  }
});
