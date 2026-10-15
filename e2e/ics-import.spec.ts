import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';
const CALENDAR = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:paris',
  'SUMMARY:Paris standup',
  'DTSTART;TZID=Europe/Paris:20260703T090000',
  'DTEND;TZID=Europe/Paris:20260703T100000',
  'ATTENDEE;CN=Ana:mailto:ana@example.test',
  'DESCRIPTION:Discuss the launch with ana@example.test',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:point',
  'SUMMARY:Check in',
  'DTSTART:20260703T120000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:day',
  'SUMMARY:Day away',
  'DTSTART;VALUE=DATE:20260704',
  'DTEND;VALUE=DATE:20260705',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
async function drop(page: Page) {
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const box = await page.getByTestId('inbox-page').boundingBox();
  if (!box) throw new Error('Inbox has no bounds');
  await page.evaluate(
    ({ content, at }) =>
      window.__cerebroMockDrop({ at, files: [{ path: '/outside/team.ics', content }] }),
    { content: CALENDAR, at: { x: box.x + box.width / 2, y: box.y + box.height / 2 } },
  );
}
test('calendar drop previews times and people, imports once, and re-imports unchanged', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await seedFileBeforeBoot(
    page,
    'types/meeting.md',
    '---\ntype: Type\nfields:\n  when: { kind: daterange }\n  cadence: { kind: repeat }\n  attendees: { kind: person }\n---\n# Meeting\n',
  );
  await seedFileBeforeBoot(
    page,
    'types/Contact.md',
    '---\ntype: Type\nfields:\n  email: { kind: email }\n---\n# Contact\n',
  );
  await seedFileBeforeBoot(
    page,
    'people/ana-calendar.md',
    '---\ntype: Contact\nemail: ana@example.test\n---\n# Ana\n',
  );
  await boot(page);
  await drop(page);
  const dialog = page.getByTestId('ics-import-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Calendar database')).toHaveValue('Meeting');
  await expect(dialog.getByLabel('Calendar preview')).toContainText('09:00:00+02:00');
  await expect(dialog.getByLabel('Calendar import report')).toContainText('People linked: 1');
  const imported = () =>
    page.evaluate(() =>
      [...window.__cerebroMockFs].filter(
        ([path, text]) =>
          path.startsWith('records/meetings/') && /^source_system: ["']?ics["']?$/m.test(text),
      ),
    );
  expect(await imported()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('calendar-preview.png'), animations: 'disabled' });
  await page.getByTestId('ics-import-submit').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await imported()).length).toBe(3);
  const originals = await imported();
  expect(
    originals.every(
      ([path, text]) => path.startsWith('records/meetings/') && !text.includes('ana@example.test'),
    ),
  ).toBe(true);
  const paris = originals.find(([path]) => path.includes('paris-standup'))!;
  expect(paris[1]).toContain('2026-07-03T09:00:00+02:00');
  expect(paris[1]).toContain('* Time zone: Europe/Paris');
  const point = originals.find(([path]) => path.includes('check-in'))!;
  expect(point[1]).toContain('start: 2026-07-03T12:00:00Z');
  expect(point[1]).not.toContain('end:');
  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await imported()).length).toBe(0);
  await page.getByTestId('toast-host').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(imported).toEqual(originals);
  await drop(page);
  await page.getByTestId('ics-import-submit').click();
  await expect(page.getByTestId('toast-host')).toContainText('3 already imported, unchanged');
  expect(await imported()).toEqual(originals);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Paris standup');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Paris standup' }).first().click();
  await expect(page.getByTestId('detail-title')).toHaveValue('Paris standup');
  expect(await readMockFile(page, paris[0])).toBe(paris[1]);
});
