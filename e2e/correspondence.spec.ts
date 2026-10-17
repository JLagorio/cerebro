import { expect, test, type Page } from '@playwright/test';
import DIGESTS from '../src-tauri/fixtures/thread-digests.json' with { type: 'json' };
import { boot, seedFileBeforeBoot } from './boot';

async function open(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(name);
  await page.getByTestId('quick-open-result').filter({ hasText: name }).first().click();
  if (name !== 'Plain address')
    await page
      .getByTestId('detail-panel')
      .getByRole('button', { name: 'Open in full page' })
      .click();
  await expect(page.getByTestId('doc-title')).toHaveText(name);
}
test('records match cached mail only through uniquely declared addresses', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1450, height: 1000 });
  await seedFileBeforeBoot(
    page,
    'types/contact.md',
    '---\ntype: Type\nfields:\n  email: email\n---\n# Contact\n',
  );
  for (const [slug, name, email] of [
    ['dana-contact', 'Dana Contact', 'dana@example.test'],
    ['lee-one', 'Lee One', 'lee@globex.example'],
    ['lee-two', 'Lee Two', 'lee@globex.example'],
    ['no-mail-contact', 'No Mail Contact', 'unmatched@acme.example'],
  ])
    await seedFileBeforeBoot(
      page,
      `contacts/${slug}.md`,
      `---\ntype: Contact\nemail: ${email}\n---\n# ${name}\n`,
    );
  await seedFileBeforeBoot(
    page,
    'notes/plain-address.md',
    '---\nemail: dana@example.test\n---\n# Plain address\n',
  );
  for (const name of ['waiting-on-you', 'two-people-replied'])
    await seedFileBeforeBoot(
      page,
      `sources/mail/${name}.md`,
      DIGESTS.find((row) => row.name === name)!.content!,
    );
  await boot(page);
  await open(page, 'Dana Contact');
  const section = page.getByTestId('correspondence-section');
  await expect(section).toContainText('2 threads · waiting on you in 1');
  await expect(section).toContainText('Last emailed');
  await section.scrollIntoViewIfNeeded();
  const box = (await section.boundingBox())!;
  expect(box.width).toBeGreaterThan(300);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1450);
  await page.screenshot({ path: info.outputPath('correspondence.png'), animations: 'disabled' });
  await section
    .getByRole('button', { name: /Launch/ })
    .first()
    .click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText('Launch');
  await open(page, 'Lee One');
  await expect(section).toContainText('is also on Lee Two');
  await section.getByRole('button', { name: 'Lee Two' }).click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText('Lee Two');
  await expect(section).toContainText('is also on Lee One');
  await open(page, 'No Mail Contact');
  await expect(section).toContainText('No cached thread includes unmatched@acme.example.');
  await open(page, 'Plain address');
  await expect(section).toHaveCount(0);
});
