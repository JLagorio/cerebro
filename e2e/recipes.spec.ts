import { expect, test } from '@playwright/test';
import { boot, openStateLab, openAssistantPanel, openDestination } from './boot';

test('the Library adds editable recipes and a skill mentioning Inbox never proposes filing', async ({
  page,
}) => {
  await boot(page);
  await openDestination(page, 'Library');
  await page.getByTestId('library-tab-skill').click();
  const offer = page.getByTestId('recipes-offer');
  await expect(offer).toContainText('Catch me up, Draft reply, What I did');
  await page.screenshot({ path: '/private/tmp/cerebro-recipes-offer.png', fullPage: true });
  await offer.getByRole('button', { name: 'Add recipes' }).click();
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('library-card').filter({ hasText: 'Catch me up' })).toHaveCount(1);
  await expect(page.getByTestId('library-card').filter({ hasText: 'What I did' })).toHaveCount(1);
  for (const slug of ['catch-me-up', 'draft-reply', 'what-i-did']) {
    const raw = await page.evaluate(
      (name) => window.__cerebroMockFs.get(`records/skills/${name}.md`),
      slug,
    );
    expect(raw).toContain(`slug: ${slug}`);
  }
  const before = await page.evaluate(() => [...window.__cerebroMockFs]);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill('/catch-me-up');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('[data-testid="chat-message"][data-role="assistant"]')).toContainText(
    'This recipe writes nothing.',
    { timeout: 10000 },
  );
  await expect(panel.getByTestId('proposal-card')).toHaveCount(0);
  expect(await page.evaluate(() => [...window.__cerebroMockFs])).toEqual(before);
});
test('the empty-vault kit includes all three recipes', async ({ page }) => {
  await boot(page, { vault: 'empty' });
  await openDestination(page, 'Home');
  await page.getByRole('button', { name: 'Add the starter kit' }).click();
  await expect(page.getByTestId('doc-title')).toContainText('Getting started');
  expect(
    await page.evaluate(() =>
      ['catch-me-up', 'draft-reply', 'what-i-did'].every((slug) =>
        window.__cerebroMockFs.has(`records/skills/${slug}.md`),
      ),
    ),
  ).toBe(true);
});
test('a failed scan and a refused add preserve the offer’s honest state', async ({ page }) => {
  await openStateLab(page, 'recipes-offer', 'unavailable');
  await expect(page.getByTestId('section-unavailable')).toContainText(
    'The library could not be read.',
  );
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add recipes' })).toBeVisible();
  await openStateLab(page, 'recipes-offer', 'partial');
  await page.getByRole('button', { name: 'Add recipes' }).click();
  await expect(page.getByTestId('recipes-offer')).toBeVisible();
  expect(
    await page.evaluate(() => window.__cerebroMockFs.has('records/skills/catch-me-up.md')),
  ).toBe(false);
});
