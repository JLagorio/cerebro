import { expect, test } from '@playwright/test';
import { boot, seedFileBeforeBoot, readMockFile, showDatabases } from './boot';
const type =
  '---\ntype: Type\nfolder: people\nfields:\n  email: email\n  company:\n    kind: relation\n    target: Company\n---\n# Person\n';
const digest =
  '---\nsource_kind: thread\nparticipants: [me@our.example, newperson@initech.example, friend@gmail.com, support@vendor.example, dana@acme.example]\nsent_to: [newperson@initech.example, friend@gmail.com, support@vendor.example, dana@acme.example]\nowner_addresses: [me@our.example]\nfirst_message_at: 2026-07-27T09:00:00Z\nlast_message_at: 2026-07-27T10:00:00Z\nlast_sent_at: 2026-07-27T09:00:00Z\nlast_from: newperson@initech.example\nneeds_reply: true\nmessage_count: 2\n---\n# Introductions\n';
test('on demand creates pages, links a company, dismisses locally and restores', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1450, height: 1000 });
  await seedFileBeforeBoot(page, 'types/person.md', type);
  await seedFileBeforeBoot(
    page,
    'types/company.md',
    '---\ntype: Type\nfolder: companies\nemail_domain: domain\nfields:\n  domain: text\n---\n# Company\n',
  );
  await seedFileBeforeBoot(
    page,
    'people/dana.md',
    '---\ntype: Person\nemail: dana@acme.example\n---\n# Dana Person\n',
  );
  await seedFileBeforeBoot(page, 'sources/mail/unfiled.md', digest);
  await boot(page);
  await showDatabases(page);
  await page
    .getByTestId('sidebar-type')
    .filter({ hasText: /^Person/ })
    .click();
  const button = page.getByTestId('unfiled-open');
  await expect(button).toHaveText('Unfiled correspondents');
  await button.click();
  const lane = page.getByTestId('unfiled-correspondents'),
    rows = lane.getByTestId('unfiled-row');
  await expect(rows).toHaveCount(2);
  const friend = rows.filter({ hasText: 'friend@gmail.com' }),
    person = rows.filter({ hasText: 'newperson@initech.example' });
  await expect(friend.getByRole('button', { name: 'Create company' })).toHaveCount(0);
  await person.getByRole('button', { name: 'Create company' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.has('companies/initech.md')))
    .toBe(true);
  await expect
    .poll(() => readMockFile(page, 'companies/initech.md'))
    .toContain('domain: initech.example');
  await expect(person).toContainText('at Initech');
  await page.screenshot({ path: info.outputPath('unfiled.png'), animations: 'disabled' });
  await person.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.has('people/newperson.md')))
    .toBe(true);
  await expect
    .poll(() => readMockFile(page, 'people/newperson.md'))
    .toContain('company: "[[initech]]"');
  await expect(rows).toHaveCount(1);
  await friend.getByRole('button', { name: 'Not a person' }).click();
  await expect(rows).toHaveCount(0);
  await lane.getByRole('button', { name: 'Show 1 dismissed' }).click();
  await lane.getByRole('button', { name: 'Restore' }).click();
  await expect(rows).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(button).toHaveText('Unfiled correspondents');
});
test('all five lane states remain distinct in the state lab', async ({ page }) => {
  for (const state of ['ready', 'empty', 'not-recorded', 'partial', 'unavailable']) {
    await page.goto(`/state-lab.html?section=unfiledCorrespondents&state=${state}`);
    await expect(page.getByTestId('unfiled-correspondents')).toHaveAttribute('data-state', state);
  }
});
