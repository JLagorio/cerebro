import { expect, test } from '@playwright/test';
import { boot, chooseSettingsSection } from './boot';

for (const theme of ['light', 'dark'] as const) {
  test(`local product help is readable and keyboard reachable at minimum size (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await boot(page);
    await page
      .getByTestId('app-rail')
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await page.getByTestId(`theme-${theme}`).click();
    await chooseSettingsSection(page, 'About');
    await page.getByRole('button', { name: 'Browse guides' }).click();
    const topic = page.getByRole('button', { name: 'Review knowledge', exact: true });
    await expect(topic).toBeFocused();
    await page.keyboard.press('Enter');
    const article = page.getByRole('article');
    await expect(article).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Review knowledge', exact: true }),
    ).toBeFocused();
    await expect(article).toContainText('Verify');
    expect(await article.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/private/tmp/cerebro-product-help-${theme}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'All guides' }).click();
    await expect(topic).toBeFocused();
    await page.getByRole('button', { name: 'Recover from a problem' }).click();
    await expect(article).toContainText('not a backup after a crash');
  });
}
