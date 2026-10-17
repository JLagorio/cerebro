import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { chooseSettingsSection, boot, seedBeforeBoot, openDestination } from './boot';
const cases = JSON.parse(readFileSync('src-tauri/fixtures/thread-digests.json', 'utf8')) as {
  name: string;
  content?: string;
  text_content?: string;
}[];
const content = (name: string) => {
  const value = cases.find((row) => row.name === name)?.content;
  if (!value) throw new Error(`Missing mail fixture: ${name}`);
  return value;
};
test('Settings reports the closed gate and cached threads, and a digest opens as a page', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedBeforeBoot(page, '__cerebroSeedFiles', {
    'sources/mail/thread-1.md': content('two-people-replied'),
    'sources/mail/thread-2.md': content('waiting-on-you')
      .replaceAll('thread-1', 'thread-2')
      .replaceAll('Launch', 'Follow-up'),
    'sources/web/legacy-mail.md':
      '---\nsource_kind: web\nsource_id: https://mail.google.com/mail/legacy\n---\n# Legacy mail copy\n',
  });
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Mail');
  const settings = page.getByTestId('settings-mail');
  await expect(settings.getByTestId('mail-gate')).toHaveAttribute('data-state', 'closed');
  await expect(settings.getByTestId('mail-cached')).toContainText('2 threads cached');
  await expect(settings).toContainText('Kept out of git: sources/mail/');
  await expect(settings.getByTestId('mail-legacy')).toContainText('Legacy mail copy');
  await settings.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('mail-settings.png'), animations: 'disabled' });
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('A header digest');
  await page.getByTestId('quick-open-content-result').filter({ hasText: 'Launch' }).first().click();
  await expect(page.getByTestId('markdown-editor')).toContainText(
    'A header digest of a mail thread',
  );
  await expect(page.getByTestId('markdown-editor')).toContainText('Dana');
  expect(await page.evaluate(() => window.__cerebroMockFs.get('sources/mail/thread-1.md'))).toBe(
    content('two-people-replied'),
  );
  await page.getByTestId('markdown-editor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('mail-digest-page.png'), animations: 'disabled' });
});

test('requested text is readable as text and adds no task to Home or My work', async ({
  page,
}, info) => {
  const row = cases.find((row) => row.name === 'text-escaped')!;
  await seedBeforeBoot(page, '__cerebroSeedFiles', {
    'sources/mail/thread-1.md': row.content!,
    'sources/mail/thread-1-text.md': row.text_content!,
  });
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Mail-only phantom task');
  await page.getByTestId('quick-open-content-result').first().click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor).toContainText('[[Launch]]');
  await expect(editor).toContainText('- [ ] Mail-only phantom task');
  await expect(editor).toContainText('📅 2026-07-28');
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  await editor.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('mail-message-text.png'), animations: 'disabled' });
  for (const name of ['Home', 'My work'] as const) {
    await openDestination(page, name);
    await expect(page.getByText('Mail-only phantom task', { exact: true })).toHaveCount(0);
  }
  expect(
    await page.evaluate(() => window.__cerebroMockFs.get('sources/mail/thread-1-text.md')),
  ).toBe(row.text_content);
});
test('retention moves a digest and its text to Trash and one Undo restores both', async ({
  page,
}, info) => {
  const row = cases.find((row) => row.name === 'with-text')!;
  const old = row.content!.replaceAll('2026-07', '2020-07');
  const bytes = {
    'sources/mail/thread-1.md': old,
    'sources/mail/thread-1-text.md': row.text_content!,
  };
  await seedBeforeBoot(page, '__cerebroSeedFiles', bytes);
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Mail');
  const settings = page.getByTestId('settings-mail');
  await expect(settings.getByRole('button', { name: 'Add Mail sweep' })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Add Mail sweep' })).toHaveAttribute(
    'title',
    'Mail caching is not enabled in this build.',
  );
  await expect(settings.getByTestId('mail-prune')).toContainText(
    '1 digest and 1 text page go to Recently deleted.',
  );
  await settings.getByRole('button', { name: 'Remove cached mail' }).click();
  await expect(settings.getByTestId('mail-cached')).toContainText('No mail cached.');
  const trash = await page.evaluate(() =>
    [...window.__cerebroMockFs.entries()].filter(([path]) => path.startsWith('.trash/')),
  );
  for (const [path, content] of Object.entries(bytes))
    expect(trash.some(([target, body]) => target.endsWith(path) && body === content)).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(settings.getByTestId('mail-cached')).toContainText('1 thread cached');
  for (const [path, body] of Object.entries(bytes))
    expect(await page.evaluate((path) => window.__cerebroMockFs.get(path), path)).toBe(body);
  await settings.getByTestId('mail-prune').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('mail-retention.png'), animations: 'disabled' });
});
