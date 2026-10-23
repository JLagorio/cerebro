import { expect, test } from '@playwright/test';
import DIGESTS from '../src-tauri/fixtures/thread-digests.json' with { type: 'json' };
import {
  boot,
  chooseSettingsSection,
  seedFileBeforeBoot,
  readMockFile,
  showDatabases,
  openDestination,
} from './boot';
const person =
  '---\ntype: Type\nfolder: people\nfields:\n  role: text\n  phone: phone\nviews:\n  - id: mine\n    name: My people\n    presentation:\n      type: table\n---\n# Person\n\nKeep this exact body.\n';
test('the optional pack adds declarations in one batch, shows company mail and undoes exact bytes', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1450, height: 1000 });
  await seedFileBeforeBoot(page, 'types/person.md', person);
  await seedFileBeforeBoot(
    page,
    'companies/acme.md',
    '---\ntype: Company\ndomain: acme.example\nstage: talking\n---\n# Acme Company\n',
  );
  await seedFileBeforeBoot(
    page,
    'companies/without-stage.md',
    '---\ntype: Company\ndomain: other.example\n---\n# Without stage\n',
  );
  const digest = DIGESTS.find((row) => row.name === 'two-people-replied')!.content!.replaceAll(
    'dana@example.test',
    'dana@acme.example',
  );
  await seedFileBeforeBoot(page, 'sources/mail/people-pack.md', digest);
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Mail');
  const pack = page.getByTestId('pack-people');
  await expect(pack).toContainText('Creates types/company.md.');
  await expect(pack).toContainText('Adds email, company and last interaction to Person.');
  await pack.getByRole('button', { name: 'Install', exact: true }).click();
  await expect.poll(() => readMockFile(page, 'types/company.md')).toContain('email_domain: domain');
  const added = await readMockFile(page, 'types/person.md');
  expect(added).toContain('name: My people');
  expect(added).toContain('Keep this exact body.');
  expect(added).toContain('source: correspondence');
  await expect(pack).toContainText('Already there: Company.');
  await expect(pack.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await showDatabases(page);
  await page
    .getByTestId('sidebar-type')
    .filter({ hasText: /^Company/ })
    .click();
  await expect(page.getByTestId('board-column')).toHaveCount(6);
  await expect(page.getByTestId('board-card').filter({ hasText: 'Acme Company' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('company-pipeline.png'), animations: 'disabled' });
  await page.getByTestId('board-card').filter({ hasText: 'Acme Company' }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel.getByTestId('correspondence-section')).toContainText('Mail with acme.example');
  await expect(panel.getByTestId('correspondence-section')).toContainText('1 thread');
  await expect(panel).toContainText('2026-07-27 11:00');
  await page.keyboard.press('Escape');
  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => readMockFile(page, 'types/person.md')).toBe(person);
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.has('types/company.md')))
    .toBe(false);
});
