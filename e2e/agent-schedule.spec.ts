import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';
const PATH = 'records/agents/release-scout.md';
const schedule = async (page: Page) =>
  YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(await readMockFile(page, PATH))![1])
    .schedule as unknown;
async function openScout(page: Page) {
  await page
    .getByTestId('sidebar')
    .getByRole('button', { name: 'Release scout', exact: true })
    .click();
  await expect(page.getByTestId('doc-title')).toHaveText('Release scout');
}
async function editSchedule(page: Page) {
  await page.getByTestId('agent-prop-schedule').getByTestId('agent-prop-open').click();
  return page.getByTestId('agent-editor-schedule');
}
test('a phrase and monthly list persist, next time is soonest, and an invalid phrase cancels cleanly', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await page.clock.setFixedTime(new Date('2026-07-28T12:00:00Z'));
  await openScout(page);
  let editor = await editSchedule(page);
  await editor.getByLabel('Type a schedule').fill('mondays and thursdays at 5pm');
  await editor.getByLabel('Type a schedule').press('Enter');
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => schedule(page)).toBe('weekly mon,thu 17:00');
  editor = await editSchedule(page);
  await editor.getByLabel('Repeat', { exact: true }).selectOption('monthly');
  await editor.getByLabel('Day of month').selectOption('last');
  await editor.getByLabel('Time', { exact: true }).fill('18:00');
  await editor.getByRole('button', { name: 'Add a time' }).click();
  await editor.getByLabel('Repeat', { exact: true }).nth(1).selectOption('weekdays');
  await editor.getByLabel('Time', { exact: true }).nth(1).fill('08:30');
  await page.screenshot({ path: info.outputPath('schedule-list.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => schedule(page)).toEqual(['monthly last 18:00', 'weekdays 08:30']);
  await expect(page.getByTestId('dossier-next-fire')).toContainText('2026-07-29 08:30');
  const before = await readMockFile(page, PATH);
  editor = await editSchedule(page);
  await editor.getByLabel('Type a schedule').fill('every 30th at 9am');
  await editor.getByLabel('Type a schedule').press('Enter');
  await expect(editor.getByRole('alert')).toContainText('days 1 to 28');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readMockFile(page, PATH)).toBe(before);
});
async function waiting(page: Page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  const line = page.getByText(/^\d+ background jobs? waiting\.$/);
  return (await line.count()) === 0 ? '0' : await line.textContent();
}
test('Resume and an earlier schedule edit leave the waiting count unchanged with Learn off', async ({
  page,
}) => {
  await boot(page, { autoLearn: false });
  await page.clock.setFixedTime(new Date('2026-07-28T12:00:00Z'));
  await openScout(page);
  await page.getByTestId('agent-duty-toggle').click();
  await expect(page.getByTestId('agent-duty-toggle')).toHaveText('Resume');
  let editor = await editSchedule(page);
  await editor.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await editor.getByLabel('Time', { exact: true }).fill('08:00');
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => schedule(page)).toBe('daily 08:00');
  const before = await waiting(page);
  await openScout(page);
  await page.getByTestId('agent-duty-toggle').click();
  await expect(page.getByTestId('agent-duty-toggle')).toHaveText('Pause');
  expect(await waiting(page)).toBe(before);
  await openScout(page);
  editor = await editSchedule(page);
  await editor.getByLabel('Time', { exact: true }).fill('07:00');
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => schedule(page)).toBe('daily 07:00');
  expect(await waiting(page)).toBe(before);
});
