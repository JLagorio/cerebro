import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { boot, seedFileBeforeBoot, openAssistantPanel } from './boot';

const path = 'records/skills/draft-reply.md';
const recipe = readFileSync('shared/starter/vault/records/skills/draft-reply.md', 'utf8');

test('draft reply offers its inputs, shows external calls and leaves the vault unchanged', async ({
  page,
}, testInfo) => {
  await seedFileBeforeBoot(
    page,
    path,
    recipe.replace('YOUR SIGNATURE HERE\n```', 'Thanks,\nAvery\n```'),
  );
  await boot(page);
  const before = await page.evaluate(() => [...window.__cerebroMockFs]);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  const input = panel.getByLabel('Message the assistant');
  await input.fill('/draft');
  await expect(panel.getByTestId('skill-menu')).toContainText('/draft-reply <thread> [points]');
  await input.fill('/draft-reply https://mail.google.com/mail/u/0/#inbox/abc');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(reply).toContainText('Nothing was sent.', { timeout: 10000 });
  const get = panel
    .locator('[data-external="true"][data-server="gmail"]')
    .filter({ hasText: 'get thread' });
  const create = panel
    .locator('[data-external="true"][data-server="gmail"]')
    .filter({ hasText: 'create draft' });
  await expect(get).toHaveCount(1);
  await expect(create).toHaveCount(1);
  await expect(get).toHaveAttribute('data-write', 'false');
  await expect(create).toHaveAttribute('data-write', 'false');
  await expect(create.getByTestId('action-server')).toHaveAttribute(
    'title',
    'Ran on the gmail connector, outside this vault',
  );
  await create.getByRole('button').first().click();
  await expect(create).toContainText('replyToMessageId');
  await expect(create).toContainText('Thanks,');
  await expect(create).toContainText('Avery');
  await expect(create).not.toContainText('htmlBody');
  await expect(create).not.toContainText('bcc');
  await expect(panel.getByTestId('diff-view')).toHaveCount(0);
  await expect(reply.getByRole('link', { name: 'draft is in Gmail' })).toHaveAttribute(
    'href',
    'https://mail.google.com/mail/u/0/#drafts/mock-draft',
  );
  expect(await page.evaluate(() => [...window.__cerebroMockFs])).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('draft-reply.png'), fullPage: true });
});

test('the shipped placeholder stays out of the draft and a missing thread asks first', async ({
  page,
}) => {
  await seedFileBeforeBoot(page, path, recipe);
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  const input = panel.getByLabel('Message the assistant');
  await input.fill('/draft-reply');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('[data-role="assistant"]')).toContainText('Which Gmail thread');
  await expect(panel.locator('[data-external="true"]')).toHaveCount(0);
  await input.fill('/draft-reply abc');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    panel.locator('[data-testid="chat-message"][data-role="assistant"]').last(),
  ).toContainText('no signature');
  const create = panel.locator('[data-external="true"]').filter({ hasText: 'create draft' });
  await create.getByRole('button').first().click();
  await expect(create).not.toContainText('YOUR SIGNATURE HERE');
});
